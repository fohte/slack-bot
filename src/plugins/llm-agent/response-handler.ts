import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import {
  CLEAR_STATUS,
  trySetAssistantStatus,
} from '@/plugins/llm-agent/assistant-status'
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
    if (task.phase !== 'Completed' && task.phase !== 'Failed') {
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
    let sessionId: string | undefined
    if (task.phase === 'Completed') {
      // Resumed thread: the opencode session title still matches the *first*
      // task.name in this thread, so findSessionIdByTitle would miss it on
      // the 2nd+ turn. Look up by Slack thread instead.
      try {
        sessionId = await threadSessionStore.lookup({
          slackTeamId: row.slackTeamId,
          slackChannelId: row.slackChannelId,
          threadRootTs: row.threadRootTs,
        })
      } catch (error) {
        logger.error(
          {
            event: 'llm_agent_response_thread_session_lookup_failed',
            task_name: task.name,
            err: error,
          },
          'failed to look up opencode session via thread_session_map; falling back to title lookup',
        )
      }
      if (sessionId === undefined) {
        // First turn in a thread: thread_session_map is only written after a
        // successful response, so it's empty here. Our wrapper sets the
        // opencode session title to task.name, so look it up that way.
        try {
          sessionId = await opencodeClient.findSessionIdByTitle(task.name)
        } catch (error) {
          logger.error(
            {
              event: 'llm_agent_response_session_lookup_failed',
              task_name: task.name,
              err: error,
            },
            'failed to look up opencode session by title; falling back to placeholder text',
          )
        }
      }
      let assistantText: string | undefined
      if (sessionId !== undefined) {
        try {
          assistantText =
            await opencodeClient.fetchLatestAssistantText(sessionId)
        } catch (error) {
          // Don't throw: re-trying every tick when opencode is down would
          // leave the user with no notification at all. Post the fallback
          // so they at least learn the Task finished.
          logger.error(
            {
              event: 'llm_agent_response_opencode_fetch_failed',
              task_name: task.name,
              session_id: sessionId,
              err: error,
            },
            'failed to fetch latest assistant message from opencode; falling back to placeholder text',
          )
        }
      } else {
        logger.warn(
          {
            event: 'llm_agent_response_session_not_found',
            task_name: task.name,
          },
          'opencode session not found for Completed Task; terminating with placeholder',
        )
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

    await trySetAssistantStatus({
      slackClient,
      target: {
        channelId: row.slackChannelId,
        threadTs: row.threadRootTs,
      },
      status: CLEAR_STATUS,
      logger,
    })

    if (task.phase === 'Completed' && sessionId !== undefined) {
      try {
        await threadSessionStore.upsert({
          slackTeamId: row.slackTeamId,
          slackChannelId: row.slackChannelId,
          threadRootTs: row.threadRootTs,
          opencodeSessionId: sessionId,
        })
      } catch (error) {
        logger.error(
          {
            event: 'llm_agent_response_session_upsert_failed',
            task_name: task.name,
            session_id: sessionId,
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
        session_id: sessionId,
      },
      'llm-agent posted Task CR response to Slack',
    )

    return 'responded'
  }
}
