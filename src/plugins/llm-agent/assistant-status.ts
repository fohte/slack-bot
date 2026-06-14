import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import type { SlackWebClient } from '@/slack/web-client'

// Slack renders this as "<bot name> 考え中…" under the user's message
// in the Agents & AI Apps split-view.
export const DEFAULT_THINKING_STATUS = '考え中…'

// Slack clears the indicator when status is set to an empty string.
export const CLEAR_STATUS = ''

export interface AssistantStatusTarget {
  readonly channelId: string
  readonly threadTs: string
}

export interface SetAssistantStatusOptions {
  readonly slackClient: SlackWebClient
  readonly target: AssistantStatusTarget
  readonly status: string
  readonly logger?: Logger | undefined
}

// assistant.threads.setStatus only works inside an assistant thread
// (Agents & AI Apps split-view); calls from a plain channel fail with
// channel_not_supported. Swallow failures so the caller's main flow is
// unaffected by this display-only indicator.
export const trySetAssistantStatus = async (
  options: SetAssistantStatusOptions,
): Promise<void> => {
  const logger = options.logger ?? noopLogger
  try {
    await options.slackClient.setAssistantThreadStatus({
      channel_id: options.target.channelId,
      thread_ts: options.target.threadTs,
      status: options.status,
    })
  } catch (error) {
    logger.warn(
      {
        event: 'llm_agent_assistant_status_failed',
        channel_id: options.target.channelId,
        thread_ts: options.target.threadTs,
        status_length: options.status.length,
        err: error,
      },
      'failed to set assistant thread status; continuing without status indicator',
    )
  }
}
