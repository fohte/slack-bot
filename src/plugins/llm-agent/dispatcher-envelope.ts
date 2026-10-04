import type { Logger } from '#logger/logger'
import type { SlackEnvelope } from '#plugins/llm-agent/dispatcher-deps'
import { extractSlackImageFiles } from '#plugins/llm-agent/files'
import type { LlmAgentAcceptedEvent } from '#plugins/llm-agent/plugin'
import type { SlackFile } from '#types/slack-payloads'

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
    // ts of the reply message that triggered this turn; falls back to
    // threadRootTs when fields.ts is absent.
    triggerTs: fields.ts ?? threadRootTs,
    text: stripMentionPrefix(fields.text ?? ''),
    images: fields.images,
  }
}
