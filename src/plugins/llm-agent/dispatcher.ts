import { SpanStatusCode, trace } from '@opentelemetry/api'

import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import type {
  A2aTaskRow,
  ThreadKey,
} from '@/plugins/llm-agent/a2a-task-tracker'
import {
  INITIAL_PHASE_STATUS,
  trySetAssistantStatus,
} from '@/plugins/llm-agent/assistant-status'
import type { ImageBlock } from '@/plugins/llm-agent/conversation-agent'
import { deriveConversationThreadId } from '@/plugins/llm-agent/conversation-agent'
import type {
  DispatcherDeps,
  ResolvedDispatcherDeps,
  SlackEnvelope,
} from '@/plugins/llm-agent/dispatcher-deps'
import { resolveDeps } from '@/plugins/llm-agent/dispatcher-deps'
import {
  extractInlineFileIds,
  extractSlackImageFiles,
  isFileSharedToChannel,
  isImageFile,
  stripInlineFileIds,
} from '@/plugins/llm-agent/files'
import type { LlmAgentAcceptedEvent } from '@/plugins/llm-agent/plugin'
import { postFinalResponse } from '@/plugins/llm-agent/steps/post-final-response'
import { reportDispatchFailure } from '@/plugins/llm-agent/steps/report-dispatch-failure'
import { resolveImageBlocks } from '@/plugins/llm-agent/steps/resolve-image-blocks'
import { resumeActiveTask } from '@/plugins/llm-agent/steps/resume-active-task'
import type { InFlightTasks } from '@/server/in-flight-tasks'
import type { SlackWebClient } from '@/slack/web-client'
import type { SlackFile } from '@/types/slack-payloads'

const TRACER_NAME = 'slack-bot'
const DISPATCH_SPAN_NAME = 'slack.mention.handle'

export type TaskDispatcher = (accepted: LlmAgentAcceptedEvent) => Promise<void>

export type TaskDispatcherOptions = DispatcherDeps & {
  // Registers the backgrounded mention-processing call so a graceful-
  // shutdown handler can wait for it to finish before the process exits.
  // Omitting it leaves the call as untracked fire-and-forget.
  readonly inFlightTasks?: Pick<InFlightTasks, 'track'> | undefined
}

// Slack mentions can include a label form `<@U123|name>` in addition to the
// plain `<@U123>` form, so the optional `|...` segment must be tolerated.
const MENTION_PREFIX_PATTERN = /^\s*(?:<@[A-Z0-9_]+(?:\|[^>]*)?>\s*)+/u

const stripMentionPrefix = (text: string): string =>
  text.replace(MENTION_PREFIX_PATTERN, '').trim()

interface ExtractedFields {
  readonly channel: string | undefined
  readonly ts: string | undefined
  readonly threadTs: string | undefined
  readonly text: string | undefined
  readonly images: readonly SlackFile[]
}

const extractEventFields = (
  event: LlmAgentAcceptedEvent['event'],
): ExtractedFields => {
  if (event.type !== 'message' && event.type !== 'app_mention') {
    return {
      channel: undefined,
      ts: undefined,
      threadTs: undefined,
      text: undefined,
      images: [],
    }
  }
  return {
    channel: typeof event.channel === 'string' ? event.channel : undefined,
    ts: typeof event.ts === 'string' ? event.ts : undefined,
    threadTs: typeof event.thread_ts === 'string' ? event.thread_ts : undefined,
    text: typeof event.text === 'string' ? event.text : undefined,
    images: extractSlackImageFiles(event),
  }
}

export const envelopeFromAccepted = (
  accepted: LlmAgentAcceptedEvent,
  logger: Logger,
): SlackEnvelope | undefined => {
  const eventId = accepted.ctx.envelope.event_id
  if (eventId === undefined || eventId === '') {
    logger.warn(
      {
        event: 'llm_agent_dispatch_skipped_missing_event_id',
      },
      'llm-agent dispatcher invoked without event_id',
    )
    return undefined
  }
  const teamId = accepted.ctx.envelope.team_id
  const fields = extractEventFields(accepted.event)
  const channel = fields.channel
  const threadRootTs = fields.threadTs ?? fields.ts
  if (
    teamId === undefined ||
    channel === undefined ||
    threadRootTs === undefined
  ) {
    // Swallow rather than throw: throwing here would roll back the
    // event_log row, causing Slack retries to re-enter this branch
    // forever. Logging + accepting the event drops the bad delivery.
    logger.warn(
      {
        event: 'llm_agent_dispatch_skipped_missing_fields',
        event_id: eventId,
        has_team_id: teamId !== undefined,
        has_channel: channel !== undefined,
        has_thread_root_ts: threadRootTs !== undefined,
      },
      'llm-agent skipping dispatch: required envelope fields missing',
    )
    return undefined
  }
  return {
    eventId,
    teamId,
    channelId: channel,
    threadRootTs,
    text: stripMentionPrefix(fields.text ?? ''),
    images: fields.images,
  }
}

// A file already attached via `event.files` and also referenced by ID in the
// text (unlikely, but Slack does not forbid it) must not be downloaded twice.
const mergeImages = (
  base: readonly SlackFile[],
  extra: readonly SlackFile[],
): readonly SlackFile[] => {
  const seenIds = new Set(
    base.map((file) => file.id).filter((id): id is string => id !== undefined),
  )
  const additions = extra.filter(
    (file) => file.id === undefined || !seenIds.has(file.id),
  )
  return additions.length > 0 ? [...base, ...additions] : base
}

// Caps the number of serial files.info lookups a single message can trigger,
// so a message packed with matched tokens (real IDs or false positives)
// cannot exhaust the rate limit on its own.
const MAX_INLINE_FILE_IDS = 10

// Slack's "insert file" compose action leaves the file out of `event.files`
// and embeds its ID as plain text instead (see files.ts). Resolve those IDs
// via files.info so inline-inserted images join the same download/attach
// pipeline as drag-and-drop attachments.
export const resolveInlineImageFiles = async (
  env: SlackEnvelope,
  slackClient: SlackWebClient,
  logger: Logger,
): Promise<SlackEnvelope> => {
  const fileIds = extractInlineFileIds(env.text).slice(0, MAX_INLINE_FILE_IDS)
  if (fileIds.length === 0) return env

  const resolvedImages: SlackFile[] = []
  const matchedIds: string[] = []
  // Serial lookup, mirroring resolveImageBlocks: issuing every ID in
  // parallel would 429 the whole batch on a single rate-limit hit.
  for (const fileId of fileIds) {
    let file: SlackFile | undefined
    try {
      file = await slackClient.getFileInfo(fileId)
    } catch (error) {
      logger.warn(
        {
          event: 'llm_agent_inline_file_lookup_failed',
          event_id: env.eventId,
          slack_file_id: fileId,
          err: error,
        },
        'failed to resolve inline file reference; leaving it as plain text',
      )
      continue
    }
    if (file === undefined) {
      logger.warn(
        {
          event: 'llm_agent_inline_file_lookup_empty',
          event_id: env.eventId,
          slack_file_id: fileId,
        },
        'inline file reference resolved with no file object; leaving it as plain text',
      )
      continue
    }
    // Only images join the pipeline, matching the event.files behavior of
    // ignoring non-image attachments.
    if (!isImageFile(file)) continue
    // files.info succeeds for any file the bot token can see, not just ones
    // shared into this channel; without this check a user could reference
    // another channel's file ID (e.g. copied from a permalink) and have its
    // contents leak into this channel's agent context.
    if (!isFileSharedToChannel(file, env.channelId)) {
      logger.warn(
        {
          event: 'llm_agent_inline_file_channel_mismatch',
          event_id: env.eventId,
          slack_file_id: fileId,
        },
        'inline file reference points to a file not shared in this channel; leaving it as plain text',
      )
      continue
    }
    resolvedImages.push(file)
    matchedIds.push(fileId)
  }
  if (resolvedImages.length === 0) return env

  return {
    ...env,
    text: stripInlineFileIds(env.text, matchedIds),
    images: mergeImages(env.images, resolvedImages),
  }
}

const threadKeyFor = (env: SlackEnvelope): ThreadKey => ({
  slackTeamId: env.teamId,
  slackChannelId: env.channelId,
  threadRootTs: env.threadRootTs,
})

const respondWithConversationAgent = async (
  env: SlackEnvelope,
  resolved: ResolvedDispatcherDeps,
  images: readonly ImageBlock[],
): Promise<string> => {
  const threadId = deriveConversationThreadId({
    teamId: env.teamId,
    channelId: env.channelId,
    threadRootTs: env.threadRootTs,
  })
  const outcome = await resolved.conversationAgent.respond({
    threadId,
    userText: env.text,
    images,
    slackEventId: env.eventId,
  })
  const trimmed = outcome.text.trim()
  return trimmed.length > 0 ? outcome.text : resolved.successFallbackText
}

// Runs the (potentially slow) LLM/A2A work detached from the Slack HTTP
// handler: whichever branch runs, it always ends by posting this event's
// single response. Any unexpected failure falls back to a generic,
// ungated dispatch-failure notification.
export const runMentionInBackground = async (
  env: SlackEnvelope,
  activeTask: A2aTaskRow | undefined,
  resolved: ResolvedDispatcherDeps,
  logger: Logger,
): Promise<void> => {
  try {
    const images = await resolveImageBlocks(resolved, env)
    const text =
      activeTask !== undefined
        ? (await resumeActiveTask(env, activeTask, resolved, images)).text
        : await respondWithConversationAgent(env, resolved, images)
    await postFinalResponse(env, text, resolved)
  } catch (error) {
    logger.error(
      {
        event: 'llm_agent_process_mention_failed',
        event_id: env.eventId,
        err: error,
      },
      'llm-agent mention processing failed',
    )
    await reportDispatchFailure(env, resolved)
  }
}

export const createTaskDispatcher = (
  options: TaskDispatcherOptions,
): TaskDispatcher => {
  const logger = options.logger ?? noopLogger
  const tracer = trace.getTracer(TRACER_NAME)
  const resolved = resolveDeps(options)
  return async (accepted) => {
    const baseEnv = envelopeFromAccepted(accepted, logger)
    if (baseEnv === undefined) return
    const env = await resolveInlineImageFiles(
      baseEnv,
      resolved.slackClient,
      logger,
    )
    await tracer.startActiveSpan(
      DISPATCH_SPAN_NAME,
      {
        attributes: {
          'slack.channel': env.channelId,
          'slack.thread_ts': env.threadRootTs,
          'slack.event_id': env.eventId,
        },
      },
      async (span) => {
        try {
          // Set the indicator before the gating lookup so a fast-completing
          // background run can never have its terminal status clear race
          // ahead of our set and leave a stale indicator sitting in the
          // thread.
          await trySetAssistantStatus({
            slackClient: resolved.slackClient,
            target: { channelId: env.channelId, threadTs: env.threadRootTs },
            status: INITIAL_PHASE_STATUS.status,
            loadingMessages: INITIAL_PHASE_STATUS.loadingMessages,
            logger,
          })
          // A failure here must reach onAccepted for the event_log
          // rollback; the actual LLM/A2A work runs detached so the Slack
          // HTTP handler can ack quickly.
          const activeTask =
            await resolved.a2aTaskTracker.findActiveInputRequired(
              threadKeyFor(env),
            )
          const mentionCompletion = runMentionInBackground(
            env,
            activeTask,
            resolved,
            logger,
          )
          void options.inFlightTasks?.track(mentionCompletion)
        } catch (err) {
          span.recordException(
            err instanceof Error ? err : { message: String(err) },
          )
          span.setStatus({ code: SpanStatusCode.ERROR })
          logger.error(
            {
              event: 'llm_agent_dispatch_failed',
              event_id: env.eventId,
              err,
            },
            'llm-agent dispatch failed before background processing started',
          )
          await reportDispatchFailure(env, resolved)
          throw err
        } finally {
          span.end()
        }
      },
    )
  }
}
