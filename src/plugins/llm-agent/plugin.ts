import type { EventContext } from '@/interaction/event-context'
import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import type { Plugin, SlackAppManifestCommand } from '@/plugin/plugin'
import type {
  EventLogOutcome,
  EventLogStore,
} from '@/plugins/llm-agent/event-log-store'
import {
  extractSlackFiles,
  extractSlackImageFiles,
} from '@/plugins/llm-agent/files'
import type { ThreadSessionStore } from '@/plugins/llm-agent/thread-session-store'
import type { SlackEvent } from '@/types/slack-payloads'

export const LLM_AGENT_PLUGIN_NAME = 'llm-agent'

export const LLM_AGENT_COMMANDS: readonly SlackAppManifestCommand[] = []

export const LLM_AGENT_EVENT_SUBSCRIPTIONS: readonly string[] = [
  'message',
  'app_mention',
]

export interface LlmAgentAcceptedEvent {
  readonly ctx: EventContext
  readonly event: SlackEvent
}

export interface LlmAgentPluginOptions {
  readonly eventLogStore: EventLogStore
  readonly threadSessionStore: ThreadSessionStore
  readonly botUserId: string
  readonly logger?: Logger | undefined
  readonly onAccepted?:
    | ((accepted: LlmAgentAcceptedEvent) => void | Promise<void>)
    | undefined
}

interface ExtractedFields {
  readonly channel?: string | undefined
  readonly user?: string | undefined
  readonly ts?: string | undefined
  readonly thread_ts?: string | undefined
  readonly channel_type?: string | undefined
  readonly text?: string | undefined
  readonly file_count?: number | undefined
  readonly image_count?: number | undefined
}

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const extractFields = (event: SlackEvent): ExtractedFields => {
  if (event.type !== 'message' && event.type !== 'app_mention') return {}
  const files = extractSlackFiles(event)
  const imageCount = extractSlackImageFiles(event).length
  return {
    channel: asOptionalString(event.channel),
    user: asOptionalString(event.user),
    ts: asOptionalString(event.ts),
    thread_ts: asOptionalString(event.thread_ts),
    channel_type: asOptionalString(event.channel_type),
    text: asOptionalString(event.text),
    file_count: files.length > 0 ? files.length : undefined,
    image_count: imageCount > 0 ? imageCount : undefined,
  }
}

const isBotMessage = (event: SlackEvent): boolean => {
  if (event.type === 'message') {
    return event.subtype === 'bot_message' || event.bot_id !== undefined
  }
  if (event.type === 'app_mention') {
    return event.bot_id !== undefined
  }
  return false
}

type GateReason =
  | 'app_mention'
  | 'dm'
  | 'thread_continuation'
  | 'duplicate_of_app_mention'
  | 'no_mention_no_thread_session'
  | 'unsupported_message_subtype'
  | 'unsupported_event'

interface GateDecision {
  readonly accept: boolean
  readonly reason: GateReason
}

// `file_share` carries the actual message in the same top-level
// `text`/`files` fields as a plain message, so it can go through the same
// gating logic below.
const SUPPORTED_MESSAGE_SUBTYPES = new Set(['file_share'])

const decideForMessage = async (
  event: SlackEvent,
  fields: ExtractedFields,
  mentionPattern: RegExp,
  threadSessionStore: ThreadSessionStore,
  teamId: string | undefined,
): Promise<GateDecision> => {
  // Other subtypes (message_changed, message_deleted, channel_join, ...)
  // carry user-visible text in a nested field and Slack does not emit a
  // paired app_mention even when the edited body mentions the bot.
  //
  // `event.subtype` narrows to `{} | null` (not `string`) under
  // `!== undefined` because `SlackUnknownEvent`'s index signature keeps
  // `unknown` in the union for the `type === 'message'` branch; the
  // `typeof` check both satisfies the compiler and keeps a non-string
  // subtype (which Slack never actually sends) rejected rather than
  // silently let through.
  if (
    event.type === 'message' &&
    event.subtype !== undefined &&
    (typeof event.subtype !== 'string' ||
      !SUPPORTED_MESSAGE_SUBTYPES.has(event.subtype))
  ) {
    return { accept: false, reason: 'unsupported_message_subtype' }
  }

  if (fields.channel_type === 'im') return { accept: true, reason: 'dm' }

  // A channel message that mentions the bot is also delivered as a separate
  // `app_mention` event; let that delivery handle it.
  if (fields.text !== undefined && mentionPattern.test(fields.text)) {
    return { accept: false, reason: 'duplicate_of_app_mention' }
  }

  // Skip the lookup for top-level channel messages: thread_ts is undefined,
  // so the message is not part of an existing thread and no session can
  // possibly be mapped to it.
  if (
    fields.thread_ts !== undefined &&
    teamId !== undefined &&
    fields.channel !== undefined
  ) {
    const sessionId = await threadSessionStore.lookup({
      slackTeamId: teamId,
      slackChannelId: fields.channel,
      threadRootTs: fields.thread_ts,
    })
    if (sessionId !== undefined) {
      return { accept: true, reason: 'thread_continuation' }
    }
  }

  return { accept: false, reason: 'no_mention_no_thread_session' }
}

export const createLlmAgentPlugin = (
  options: LlmAgentPluginOptions,
): Plugin => {
  const logger = options.logger ?? noopLogger
  const { eventLogStore, threadSessionStore, botUserId, onAccepted } = options
  // Slack mentions appear as `<@U123>` or `<@U123|label>`.
  const mentionPattern = new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, 'u')

  return {
    name: LLM_AGENT_PLUGIN_NAME,
    commands: LLM_AGENT_COMMANDS,
    eventSubscriptions: LLM_AGENT_EVENT_SUBSCRIPTIONS,
    async onEvent(ctx, event) {
      if (isBotMessage(event)) return

      const eventId = ctx.envelope.event_id
      if (eventId === undefined || eventId === '') {
        logger.warn(
          {
            event: 'llm_agent_event_missing_id',
            event_type: event.type,
            team_id: ctx.envelope.team_id,
          },
          'llm-agent received event without event_id; skipping',
        )
        return
      }

      const fields = extractFields(event)

      let decision: GateDecision
      if (event.type === 'app_mention') {
        decision = { accept: true, reason: 'app_mention' }
      } else if (event.type === 'message') {
        decision = await decideForMessage(
          event,
          fields,
          mentionPattern,
          threadSessionStore,
          ctx.envelope.team_id,
        )
      } else {
        decision = { accept: false, reason: 'unsupported_event' }
      }

      if (!decision.accept) {
        logger.info(
          {
            event: 'llm_agent_event_gated',
            event_type: event.type,
            event_id: eventId,
            team_id: ctx.envelope.team_id,
            reason: decision.reason,
            ...fields,
          },
          'llm-agent skipped event by gating rule',
        )
        return
      }

      const threadRootTs = fields.thread_ts ?? fields.ts

      let outcome: EventLogOutcome
      try {
        outcome = await eventLogStore.recordReceived({
          slackEventId: eventId,
          slackTeamId: ctx.envelope.team_id,
          slackChannelId: fields.channel,
          threadRootTs,
        })
      } catch (error) {
        logger.error(
          {
            event: 'llm_agent_event_log_failed',
            event_type: event.type,
            event_id: eventId,
            err: error,
          },
          'failed to record event in event_log',
        )
        throw error
      }

      logger.info(
        {
          event:
            outcome === 'accepted'
              ? 'llm_agent_event_accepted'
              : 'llm_agent_event_duplicate_skipped',
          event_type: event.type,
          event_id: eventId,
          team_id: ctx.envelope.team_id,
          outcome,
          gate_reason: decision.reason,
          ...fields,
        },
        outcome === 'accepted'
          ? 'llm-agent accepted event'
          : 'llm-agent skipped duplicate event',
      )

      if (outcome === 'accepted' && onAccepted !== undefined) {
        try {
          await onAccepted({ ctx, event })
        } catch (error) {
          // Roll back the accepted row so that a subsequent Slack retry is
          // re-processed instead of being silently dropped as
          // rejected_duplicate. A concurrent retry that has already taken the
          // rejected_duplicate branch can still slip through; the next-task
          // Task CR pipeline owns full at-least-once delivery.
          try {
            await eventLogStore.deleteReceived(eventId)
          } catch (rollbackError) {
            logger.error(
              {
                event: 'llm_agent_event_log_rollback_failed',
                event_id: eventId,
                err: rollbackError,
              },
              'failed to roll back event_log row after onAccepted failure',
            )
          }
          throw error
        }
      }
    },
  }
}
