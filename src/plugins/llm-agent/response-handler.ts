import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import type { EventLogStore } from '@/plugins/llm-agent/event-log-store'
import type { OpencodeClient } from '@/plugins/llm-agent/opencode-client'
import type { TaskCrStatus } from '@/plugins/llm-agent/task-cr-client'
import type { ThreadSessionStore } from '@/plugins/llm-agent/thread-session-store'
import type { SlackWebClient } from '@/slack/web-client'

export type TaskResponseOutcome =
  | 'responded'
  | 'skipped_non_terminal'
  | 'skipped_already_responded'
  | 'skipped_orphan'
  | 'skipped_missing_envelope'

export interface TaskResponseHandlerOptions {
  readonly slackClient: SlackWebClient
  readonly opencodeClient: OpencodeClient
  readonly eventLogStore: EventLogStore
  readonly threadSessionStore: ThreadSessionStore
  readonly logger?: Logger | undefined
  readonly successFallbackText?: string | undefined
}

export type TaskResponseHandler = (
  task: TaskCrStatus,
) => Promise<TaskResponseOutcome>

const DEFAULT_SUCCESS_FALLBACK =
  '(opencode did not produce an assistant message)'

// Slack mrkdwn would otherwise interpret <, >, & inside the unstructured
// k8s status message as user/channel mentions or HTML entities.
// https://docs.slack.dev/messaging/formatting-message-text#escaping
const escapeMrkdwn = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const formatFailureText = (task: TaskCrStatus): string => {
  const message = task.message?.trim()
  if (message !== undefined && message.length > 0) {
    return `Task failed: ${escapeMrkdwn(message)}`
  }
  return 'Task failed.'
}

export const createTaskResponseHandler = (
  options: TaskResponseHandlerOptions,
): TaskResponseHandler => {
  const logger = options.logger ?? noopLogger
  const successFallback =
    options.successFallbackText ?? DEFAULT_SUCCESS_FALLBACK
  const { slackClient, opencodeClient, eventLogStore, threadSessionStore } =
    options

  return async (task) => {
    if (task.phase !== 'Succeeded' && task.phase !== 'Failed') {
      return 'skipped_non_terminal'
    }

    const row = await eventLogStore.findByTaskName(task.name)
    if (row !== undefined && row.outcome === 'responded') {
      return 'skipped_already_responded'
    }
    if (row === undefined) {
      logger.warn(
        {
          event: 'llm_agent_response_orphan_task',
          task_name: task.name,
          namespace: task.namespace,
        },
        'task watcher saw terminal Task with no matching event_log row',
      )
      return 'skipped_orphan'
    }
    if (
      row.slackTeamId === undefined ||
      row.slackChannelId === undefined ||
      row.threadRootTs === undefined
    ) {
      logger.warn(
        {
          event: 'llm_agent_response_missing_envelope',
          task_name: task.name,
          slack_event_id: row.slackEventId,
          has_team_id: row.slackTeamId !== undefined,
          has_channel_id: row.slackChannelId !== undefined,
          has_thread_root_ts: row.threadRootTs !== undefined,
        },
        'event_log row missing channel/thread fields; cannot post response',
      )
      return 'skipped_missing_envelope'
    }

    let text: string
    if (task.phase === 'Succeeded') {
      let assistantText: string | undefined
      if (task.sessionId !== undefined) {
        try {
          assistantText = await opencodeClient.fetchLatestAssistantText(
            task.sessionId,
          )
        } catch (error) {
          // Don't throw: re-trying every tick when opencode is down would
          // leave the user with no notification at all. Post the fallback
          // so they at least learn the Task finished.
          logger.error(
            {
              event: 'llm_agent_response_opencode_fetch_failed',
              task_name: task.name,
              session_id: task.sessionId,
              err: error,
            },
            'failed to fetch latest assistant message from opencode; falling back to placeholder text',
          )
        }
      }
      text = assistantText ?? successFallback
    } else {
      text = formatFailureText(task)
    }

    const { updated } = await eventLogStore.markResponded(row.slackEventId)
    if (updated === 0) {
      return 'skipped_already_responded'
    }

    try {
      await slackClient.postMessage({
        channel: row.slackChannelId,
        thread_ts: row.threadRootTs,
        text,
      })
    } catch (error) {
      // Roll back the reservation so a later tick can retry. Surface the
      // original Slack failure even if the rollback itself fails.
      try {
        await eventLogStore.unmarkResponded(row.slackEventId)
      } catch (rollbackError) {
        logger.error(
          {
            event: 'llm_agent_response_unmark_failed',
            task_name: task.name,
            slack_event_id: row.slackEventId,
            err: rollbackError,
          },
          'failed to roll back event_log row after Slack post failure',
        )
      }
      throw error
    }

    if (task.phase === 'Succeeded' && task.sessionId !== undefined) {
      try {
        await threadSessionStore.upsert({
          slackTeamId: row.slackTeamId,
          slackChannelId: row.slackChannelId,
          threadRootTs: row.threadRootTs,
          opencodeSessionId: task.sessionId,
        })
      } catch (error) {
        logger.error(
          {
            event: 'llm_agent_response_session_upsert_failed',
            task_name: task.name,
            session_id: task.sessionId,
            err: error,
          },
          'failed to upsert thread_session_map after responding',
        )
      }
    }

    logger.info(
      {
        event: 'llm_agent_task_responded',
        task_name: task.name,
        slack_event_id: row.slackEventId,
        phase: task.phase,
        session_id: task.sessionId,
      },
      'llm-agent posted Task CR response to Slack',
    )

    return 'responded'
  }
}
