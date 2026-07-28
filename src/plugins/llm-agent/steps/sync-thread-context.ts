import type {
  ImageBlock,
  ThreadContextForTurn,
} from '#plugins/llm-agent/conversation-agent/index'
import { imageBlockFromDownloadedImage } from '#plugins/llm-agent/conversation-agent/index'
import type {
  ResolvedDispatcherDeps,
  SlackEnvelope,
} from '#plugins/llm-agent/dispatcher-deps'
import { isImageFile } from '#plugins/llm-agent/files'
import type { InFlightTurnKey } from '#plugins/llm-agent/in-flight-turns'
import {
  resolveThumbnail,
  SINGLE_IMAGE_BYTE_CAP,
} from '#plugins/llm-agent/steps/resolve-image-blocks'
import type { SlackThreadReplyMessage } from '#slack/web-client'
import type { SlackFile } from '#types/slack-payloads'

// Caps how many messages/characters get folded into a single turn's prompt,
// mirroring the "recent N" framing a human skimming a long thread would use.
const THREAD_CONTEXT_MESSAGE_LIMIT = 100
const THREAD_CONTEXT_CHAR_BUDGET = 16_000
const THREAD_CONTEXT_MAX_IMAGES = 4
// Comfortably above THREAD_CONTEXT_MESSAGE_LIMIT so a single page covers
// every realistic thread; only a pathologically long gap between two
// consecutive turns ever needs a second page.
const REPLIES_PAGE_LIMIT = 200
const REPLIES_MAX_PAGES = 5

export const EMPTY_THREAD_CONTEXT: ThreadContextForTurn = {
  text: undefined,
  images: [],
  contextMaxTs: undefined,
}

interface FetchedReplies {
  readonly messages: readonly SlackThreadReplyMessage[]
  readonly truncatedByPagination: boolean
}

const fetchThreadReplies = async (
  resolved: ResolvedDispatcherDeps,
  env: SlackEnvelope,
  cursor: string | undefined,
): Promise<FetchedReplies> => {
  const messages: SlackThreadReplyMessage[] = []
  let pageCursor: string | undefined
  let pages = 0
  let truncatedByPagination = false
  do {
    const page = await resolved.slackClient.getConversationReplies({
      channel: env.channelId,
      ts: env.threadRootTs,
      oldest: cursor,
      latest: env.triggerTs,
      cursor: pageCursor,
      limit: REPLIES_PAGE_LIMIT,
    })
    messages.push(...page.messages)
    pages += 1
    pageCursor = page.hasMore ? page.nextCursor : undefined
    if (pageCursor !== undefined && pages >= REPLIES_MAX_PAGES) {
      truncatedByPagination = true
      break
    }
  } while (pageCursor !== undefined)
  return { messages, truncatedByPagination }
}

const maxTsOf = (
  messages: readonly SlackThreadReplyMessage[],
): string | undefined =>
  messages.reduce<string | undefined>((max, m) => {
    if (m.ts === undefined) return max
    return max === undefined || Number(m.ts) > Number(max) ? m.ts : max
  }, undefined)

// A message paired with the ts already confirmed defined by shouldInject
// below, so every later step can rely on it without re-checking.
interface DatedMessage {
  readonly message: SlackThreadReplyMessage
  readonly ts: string
}

interface DedupContext {
  readonly botUserId: string
  readonly hasCheckpoint: boolean
  readonly channelId: string
  readonly isTurnInFlight: (key: InFlightTurnKey) => boolean
}

// Own-bot messages are excluded once a checkpoint exists (its AIMessages
// already cover them) but included on cold start, labeled as this app's own
// prior turn. Other bots are never turned into their own checkpoint entry
// (isBotMessage gates them out in plugin.ts), so this injection is the only
// way they ever reach the LLM. A human message currently being processed by
// a concurrent turn is excluded to avoid injecting content its own turn is
// about to write to the checkpoint itself. A message with no ts is excluded
// outright: neither ordering nor in-flight dedup can be determined for it.
const shouldInject = (
  message: SlackThreadReplyMessage,
  ctx: DedupContext,
): boolean => {
  if (message.ts === undefined) return false
  const isOwnBot = message.userId === ctx.botUserId
  if (isOwnBot) return !ctx.hasCheckpoint
  const isOtherBot = message.botId !== undefined
  if (isOtherBot) return true
  return !ctx.isTurnInFlight({ channelId: ctx.channelId, ts: message.ts })
}

const selectForInjection = (
  messages: readonly SlackThreadReplyMessage[],
  ctx: DedupContext,
): readonly DatedMessage[] => {
  const result: DatedMessage[] = []
  for (const message of messages) {
    const ts = message.ts
    if (ts === undefined) continue
    if (!shouldInject(message, ctx)) continue
    result.push({ message, ts })
  }
  return result
}

const toIsoTs = (ts: string): string =>
  new Date(Number(ts) * 1000).toISOString()

const authorTagFor = (
  message: SlackThreadReplyMessage,
  botUserId: string,
): string => {
  if (message.userId === botUserId) return `<@${message.userId}> (you)`
  if (message.userId !== undefined) return `<@${message.userId}>`
  if (message.botId !== undefined) return `<bot:${message.botId}>`
  return '<unknown>'
}

const fileDisplayName = (file: SlackFile): string =>
  file.name ?? file.title ?? 'file'

const buildRoughLine = (dated: DatedMessage, botUserId: string): string =>
  `[${toIsoTs(dated.ts)}] ${authorTagFor(dated.message, botUserId)}: ${(dated.message.text ?? '').trim()}`.trimEnd()

// Keeps the newest-first suffix of `messages` that fits within
// THREAD_CONTEXT_CHAR_BUDGET, always keeping at least the single newest
// message even if it alone exceeds the budget.
const fitByCharBudget = (
  roughLines: readonly string[],
): { readonly startIndex: number; readonly truncated: boolean } => {
  let total = 0
  let startIndex = roughLines.length
  for (let i = roughLines.length - 1; i >= 0; i--) {
    const line = roughLines[i] ?? ''
    const nextTotal = total + line.length + 1
    if (
      nextTotal > THREAD_CONTEXT_CHAR_BUDGET &&
      startIndex < roughLines.length
    ) {
      break
    }
    total = nextTotal
    startIndex = i
  }
  return { startIndex, truncated: startIndex > 0 }
}

const buildContextText = (
  lines: readonly string[],
  truncated: boolean,
): string => {
  const body = truncated
    ? [
        '[note: some earlier thread messages were omitted from this context]',
        ...lines,
      ]
    : lines
  return `<thread_context>\n${body.join('\n')}\n</thread_context>`
}

interface ResolvedContextImage {
  readonly file: SlackFile
  readonly block: ImageBlock
}

// Resolves thumbnails for the newest THREAD_CONTEXT_MAX_IMAGES image
// attachments across `budgeted`, serially (mirroring resolveImageBlocks:
// issuing every candidate in parallel would 429 the whole batch on a single
// rate-limit hit). A candidate whose thumbnail can't be resolved is simply
// dropped rather than failing the sync — best-effort, unlike the current
// turn's own images.
const resolveContextImages = async (
  resolved: ResolvedDispatcherDeps,
  env: SlackEnvelope,
  budgeted: readonly DatedMessage[],
): Promise<readonly ResolvedContextImage[]> => {
  const candidates = budgeted
    .flatMap((dated) => dated.message.files)
    .filter(isImageFile)
    .slice(-THREAD_CONTEXT_MAX_IMAGES)

  const resolvedImages: ResolvedContextImage[] = []
  for (const file of candidates) {
    const thumbnailResult = await resolveThumbnail(
      resolved,
      env,
      file,
      SINGLE_IMAGE_BYTE_CAP,
    )
    if (thumbnailResult.isErr()) {
      resolved.logger.warn(
        {
          event: 'llm_agent_thread_context_image_unavailable',
          event_id: env.eventId,
          slack_file_id: file.id,
          err: thumbnailResult.error,
        },
        'thread context image thumbnail unavailable; falling back to a placeholder',
      )
      continue
    }
    resolvedImages.push({
      file,
      block: imageBlockFromDownloadedImage(thumbnailResult.value),
    })
  }
  return resolvedImages
}

const buildLines = (
  budgeted: readonly DatedMessage[],
  resolvedImages: readonly ResolvedContextImage[],
  botUserId: string,
): readonly string[] => {
  const markerByFile = new Map(
    resolvedImages.map(({ file }, index) => [file, index + 1]),
  )
  const labelForFile = (file: SlackFile): string => {
    if (!isImageFile(file)) return `[添付ファイル: ${fileDisplayName(file)}]`
    const marker = markerByFile.get(file)
    return marker !== undefined
      ? `[画像 ${String(marker)}]`
      : `[画像省略: ${fileDisplayName(file)}]`
  }
  return budgeted.map((dated) => {
    const base = buildRoughLine(dated, botUserId)
    const fileLabels = dated.message.files.map(labelForFile)
    return [base, ...fileLabels].join(' ').trim()
  })
}

const logSynced = (
  resolved: ResolvedDispatcherDeps,
  env: SlackEnvelope,
  fields: {
    injectedMessageCount: number
    injectedImageCount: number
    truncated: boolean
  },
  message: string,
): void => {
  resolved.logger.info(
    {
      event: 'llm_agent_thread_context_synced',
      event_id: env.eventId,
      injected_message_count: fields.injectedMessageCount,
      injected_image_count: fields.injectedImageCount,
      truncated: fields.truncated,
    },
    message,
  )
}

export const syncThreadContext = async (
  resolved: ResolvedDispatcherDeps,
  env: SlackEnvelope,
  cursor: string | undefined,
  isTurnInFlight: (key: InFlightTurnKey) => boolean,
): Promise<ThreadContextForTurn> => {
  let fetched: FetchedReplies
  // eslint-disable-next-line no-restricted-syntax -- boundary: SlackWebClient.getConversationReplies is throw-based by design; a fetch failure here degrades to "inject nothing" per the design's context-over-availability tradeoff, rather than failing the turn
  try {
    fetched = await fetchThreadReplies(resolved, env, cursor)
  } catch (error) {
    resolved.logger.warn(
      {
        event: 'llm_agent_thread_context_fetch_failed',
        event_id: env.eventId,
        err: error,
      },
      'failed to fetch thread replies for context sync; continuing without injection',
    )
    return EMPTY_THREAD_CONTEXT
  }

  const contextMaxTs = maxTsOf(fetched.messages)
  if (fetched.messages.length === 0) {
    logSynced(
      resolved,
      env,
      { injectedMessageCount: 0, injectedImageCount: 0, truncated: false },
      'no unseen thread messages to inject',
    )
    return EMPTY_THREAD_CONTEXT
  }

  const selected = selectForInjection(fetched.messages, {
    botUserId: resolved.botUserId,
    hasCheckpoint: cursor !== undefined,
    channelId: env.channelId,
    isTurnInFlight,
  })
  const truncatedByMessageCount = selected.length > THREAD_CONTEXT_MESSAGE_LIMIT
  const windowed = selected.slice(-THREAD_CONTEXT_MESSAGE_LIMIT)

  const roughLines = windowed.map((dated) =>
    buildRoughLine(dated, resolved.botUserId),
  )
  const { startIndex, truncated: truncatedByCharBudget } =
    fitByCharBudget(roughLines)
  const budgeted = windowed.slice(startIndex)

  if (budgeted.length === 0) {
    logSynced(
      resolved,
      env,
      {
        injectedMessageCount: 0,
        injectedImageCount: 0,
        truncated: fetched.truncatedByPagination,
      },
      'every unseen thread message was excluded by dedup rules',
    )
    return { text: undefined, images: [], contextMaxTs }
  }

  const resolvedImages = await resolveContextImages(resolved, env, budgeted)
  const lines = buildLines(budgeted, resolvedImages, resolved.botUserId)
  const truncated =
    truncatedByMessageCount ||
    truncatedByCharBudget ||
    fetched.truncatedByPagination

  logSynced(
    resolved,
    env,
    {
      injectedMessageCount: lines.length,
      injectedImageCount: resolvedImages.length,
      truncated,
    },
    'synced unseen thread messages into context',
  )

  return {
    text: buildContextText(lines, truncated),
    images: resolvedImages.map(({ block }) => block),
    contextMaxTs,
  }
}
