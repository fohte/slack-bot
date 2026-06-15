import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import type { SlackWebClient } from '@/slack/web-client'

// Slack renders this as "<bot name> is thinking..." under the user's
// message in the Agents & AI Apps split-view.
export const DEFAULT_THINKING_STATUS = 'is thinking...'

// Slack clears the indicator when status is set to an empty string.
export const CLEAR_STATUS = ''

// When loading_messages is omitted, Slack fills the conversation bubble
// with its own generic copy ("Finding answers…", "Summarizing findings…"
// etc.), which misrepresents what the bot is actually doing. Pass a
// single-element array per phase to pin the bubble copy to text we own.
export interface PhaseStatus {
  readonly status: string
  readonly loadingMessages: readonly string[]
}

// Used by the dispatcher between Slack event receipt and the first time
// the watcher observes a Task CR phase; intentionally matches Pending.
export const INITIAL_PHASE_STATUS: PhaseStatus = {
  status: DEFAULT_THINKING_STATUS,
  loadingMessages: ['Preparing your task…'],
}

// The Task CR `status.phase` enum is fixed by the kubeopencode.io CRD:
//   Pending | Queued | Running | Completed | Failed
// Only non-terminal phases get a bubble message; terminal phases hand
// off to the response handler which clears the indicator.
const PHASE_STATUS_MAP: Readonly<Record<string, PhaseStatus>> = {
  Pending: INITIAL_PHASE_STATUS,
  Queued: {
    status: 'is waiting in queue...',
    loadingMessages: ['Waiting in queue…'],
  },
  Running: {
    status: 'is working on it...',
    loadingMessages: ['Working on it…'],
  },
}

export const statusForPhase = (
  phase: string | undefined,
): PhaseStatus | undefined => {
  if (phase === undefined) return undefined
  return PHASE_STATUS_MAP[phase]
}

export interface AssistantStatusTarget {
  readonly channelId: string
  readonly threadTs: string
}

export interface SetAssistantStatusOptions {
  readonly slackClient: SlackWebClient
  readonly target: AssistantStatusTarget
  readonly status: string
  readonly loadingMessages?: readonly string[] | undefined
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
      ...(options.loadingMessages !== undefined && {
        loading_messages: [...options.loadingMessages],
      }),
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
