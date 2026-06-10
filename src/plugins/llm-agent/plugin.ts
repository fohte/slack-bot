import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import type { Plugin, SlackAppManifestCommand } from '@/plugin/plugin'

export const LLM_AGENT_PLUGIN_NAME = 'llm-agent'

export const LLM_AGENT_COMMANDS: readonly SlackAppManifestCommand[] = []

export const LLM_AGENT_EVENT_SUBSCRIPTIONS: readonly string[] = [
  'message',
  'app_mention',
]

export interface LlmAgentPluginOptions {
  readonly logger?: Logger | undefined
}

export const createLlmAgentPlugin = (
  options: LlmAgentPluginOptions = {},
): Plugin => {
  const logger = options.logger ?? noopLogger

  return {
    name: LLM_AGENT_PLUGIN_NAME,
    commands: LLM_AGENT_COMMANDS,
    eventSubscriptions: LLM_AGENT_EVENT_SUBSCRIPTIONS,
    onEvent(ctx, event) {
      // Guard against self-message loops once this plugin starts posting replies.
      if (
        event.type === 'message' &&
        (event.subtype === 'bot_message' || event.bot_id !== undefined)
      ) {
        return Promise.resolve()
      }
      logger.info(
        {
          event: 'llm_agent_event_received',
          event_type: event.type,
          event_id: ctx.envelope.event_id,
          team_id: ctx.envelope.team_id,
          channel: event['channel'],
          user: event['user'],
          ts: event['ts'],
          thread_ts: event['thread_ts'],
        },
        'llm-agent received event',
      )
      return Promise.resolve()
    },
  }
}
