import { SpanStatusCode, trace } from '@opentelemetry/api'

import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import {
  INITIAL_PHASE_STATUS,
  trySetAssistantStatus,
} from '@/plugins/llm-agent/assistant-status'
import { extractSlackImageFiles } from '@/plugins/llm-agent/files'
import type { LlmAgentAcceptedEvent } from '@/plugins/llm-agent/plugin'
import { processMention } from '@/plugins/llm-agent/process-mention'
import type {
  ProcessMentionDeps,
  SlackEnvelope,
} from '@/plugins/llm-agent/process-mention-deps'
import { submitTask } from '@/plugins/llm-agent/steps/submit-task'
import type { SlackFile } from '@/types/slack-payloads'

const TRACER_NAME = 'slack-bot'
const DISPATCH_SPAN_NAME = 'slack.mention.handle'

export type TaskDispatcher = (accepted: LlmAgentAcceptedEvent) => Promise<void>

export type TaskDispatcherOptions = ProcessMentionDeps

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

export const createTaskDispatcher = (
  options: TaskDispatcherOptions,
): TaskDispatcher => {
  const logger = options.logger ?? noopLogger
  const tracer = trace.getTracer(TRACER_NAME)
  return async (accepted) => {
    const env = envelopeFromAccepted(accepted, logger)
    if (env === undefined) return
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
          // Set the indicator before submitTask so a fast-completing Task can
          // never have its terminal status clear race ahead of our set and
          // leave a stale indicator sitting in the thread.
          await trySetAssistantStatus({
            slackClient: options.slackClient,
            target: { channelId: env.channelId, threadTs: env.threadRootTs },
            status: INITIAL_PHASE_STATUS.status,
            loadingMessages: INITIAL_PHASE_STATUS.loadingMessages,
            logger,
          })
          // create() failures must reach onAccepted for the event_log rollback;
          // downstream steps run detached so the Slack HTTP handler can ack.
          const { taskName } = await submitTask(env, options)
          void processMention(env, taskName, options, {
            initialBubble: INITIAL_PHASE_STATUS,
          }).catch((error: unknown) => {
            logger.error(
              {
                event: 'llm_agent_process_mention_failed',
                event_id: env.eventId,
                err: error,
              },
              'llm-agent processMention failed',
            )
          })
        } catch (err) {
          span.recordException(
            err instanceof Error ? err : { message: String(err) },
          )
          span.setStatus({ code: SpanStatusCode.ERROR })
          throw err
        } finally {
          span.end()
        }
      },
    )
  }
}
