import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import {
  statusForPhase,
  trySetAssistantStatus,
} from '@/plugins/llm-agent/assistant-status'
import type { EventLogStore } from '@/plugins/llm-agent/event-log-store'
import type { TaskCrStatus } from '@/plugins/llm-agent/task-cr-client'
import type { SlackWebClient } from '@/slack/web-client'

export interface TaskPhaseStatusHandlerOptions {
  readonly slackClient: SlackWebClient
  readonly eventLogStore: EventLogStore
  readonly logger?: Logger | undefined
}

export type TaskPhaseStatusHandler = (task: TaskCrStatus) => Promise<void>

// Invoked by the watcher on Task CR phase transitions. Terminal phases
// (Completed / Failed) are deliberately ignored here — the response
// handler clears the indicator once it posts the reply, and racing a
// per-phase set against that clear would resurrect the indicator.
export const createTaskPhaseStatusHandler = (
  options: TaskPhaseStatusHandlerOptions,
): TaskPhaseStatusHandler => {
  const logger = options.logger ?? noopLogger
  const { slackClient, eventLogStore } = options

  return async (task) => {
    const phaseStatus = statusForPhase(task.phase)
    if (phaseStatus === undefined) return

    const row = await eventLogStore.findByTaskName(task.name)
    if (row === undefined) {
      logger.warn(
        {
          event: 'llm_agent_phase_status_orphan_task',
          task_name: task.name,
          namespace: task.namespace,
          phase: task.phase,
        },
        'phase status handler saw Task CR with no matching event_log row',
      )
      return
    }
    if (row.slackChannelId === undefined || row.threadRootTs === undefined) {
      logger.warn(
        {
          event: 'llm_agent_phase_status_missing_envelope',
          task_name: task.name,
          slack_event_id: row.slackEventId,
          phase: task.phase,
        },
        'event_log row missing channel/thread fields; cannot set phase status',
      )
      return
    }

    await trySetAssistantStatus({
      slackClient,
      target: {
        channelId: row.slackChannelId,
        threadTs: row.threadRootTs,
      },
      status: phaseStatus.status,
      loadingMessages: phaseStatus.loadingMessages,
      logger,
    })
  }
}
