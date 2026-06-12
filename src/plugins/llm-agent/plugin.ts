import type { EventContext } from '@/interaction/event-context'
import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import type { Plugin, SlackAppManifestCommand } from '@/plugin/plugin'
import type {
  EventLogOutcome,
  EventLogStore,
} from '@/plugins/llm-agent/event-log-store'
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
}

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const extractFields = (event: SlackEvent): ExtractedFields => {
  if (event.type !== 'message' && event.type !== 'app_mention') return {}
  return {
    channel: asOptionalString(event.channel),
    user: asOptionalString(event.user),
    ts: asOptionalString(event.ts),
    thread_ts: asOptionalString(event.thread_ts),
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

export const createLlmAgentPlugin = (
  options: LlmAgentPluginOptions,
): Plugin => {
  const logger = options.logger ?? noopLogger
  const { eventLogStore, onAccepted } = options

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
