import type { Logger } from '#logger/logger'
import type { SlackEnvelope } from '#plugins/llm-agent/dispatcher-deps'
import {
  extractInlineFileIds,
  isFileSharedToChannel,
  isImageFile,
  stripInlineFileIds,
} from '#plugins/llm-agent/files'
import type { SlackWebClient } from '#slack/web-client'
import type { SlackFile } from '#types/slack-payloads'

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
    // eslint-disable-next-line no-restricted-syntax -- boundary: SlackWebClient.getFileInfo is a throw-based interface method by design; this caller deliberately swallows the failure and leaves the reference as plain text
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
