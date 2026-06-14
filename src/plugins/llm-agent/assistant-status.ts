import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import type { SlackWebClient } from '@/slack/web-client'

// Slack renders this as "<bot name> is thinking..." under the user's
// message in the Agents & AI Apps split-view.
export const DEFAULT_THINKING_STATUS = 'is thinking...'

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
//
// set/clear failures are not symmetric in severity:
//   - set failure: the indicator never appears (degraded UX, acceptable)
//   - clear failure: a stale "thinking..." sits in a thread that already
//     received the reply (broken UX, operators need to know)
// clear failures are logged at error level so they surface in monitoring;
// set failures stay at warn since they are the expected outcome whenever
// the indicator is not configured.
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
    const isClear = options.status === CLEAR_STATUS
    const payload = {
      event: isClear
        ? 'llm_agent_assistant_status_clear_failed'
        : 'llm_agent_assistant_status_set_failed',
      channel_id: options.target.channelId,
      thread_ts: options.target.threadTs,
      status_length: options.status.length,
      err: error,
    }
    if (isClear) {
      logger.error(
        payload,
        'failed to clear assistant thread status; stale indicator may remain in the thread',
      )
    } else {
      logger.warn(
        payload,
        'failed to set assistant thread status; continuing without status indicator',
      )
    }
  }
}
