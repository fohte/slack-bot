import type { Task } from '@a2a-js/sdk'
import { TaskNotFoundError } from '@a2a-js/sdk/client'

import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import type { A2aReconcilerSettledReason } from '@/observability/a2a-counters'
import {
  recordA2aReconcilerSettled,
  recordA2aTaskSettled,
} from '@/observability/a2a-counters'
import type {
  A2aTaskRow,
  A2aTaskTracker,
} from '@/plugins/llm-agent/a2a-task-tracker'
import { A2A_TASK_ACTIVE_EXECUTION_STATES } from '@/plugins/llm-agent/a2a-task-tracker'
import type { EventLogStore } from '@/plugins/llm-agent/event-log-store'
import type { RemoteAgentRegistry } from '@/plugins/llm-agent/remote-agent-registry'
import type { ResponseFinalizer } from '@/plugins/llm-agent/response-finalizer'
import { postThreadMessage } from '@/plugins/llm-agent/slack-message-blocks'
import type { InFlightTasks } from '@/server/in-flight-tasks'
import type { SlackWebClient } from '@/slack/web-client'

// Grace period before an unsettled row becomes reconcile-eligible, and how
// often the reconciler ticks.
export const TASK_RECONCILER_DEFAULT_GRACE_MS = 2 * 60 * 1000
export const TASK_RECONCILER_DEFAULT_INTERVAL_MS = 60 * 1000
// Matches event_log's own 7-day TTL (event-log-retention.ts); a2a_task rows
// reference event_log loosely and have no reason to outlive it.
export const TASK_RECONCILER_DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export const DEADLINE_EXCEEDED_TEXT =
  "This task didn't finish in time, so it's being treated as failed. Please try again."

export const TASK_NOT_FOUND_TEXT =
  'The delegated agent no longer has a record of this task, so it is being treated as failed. Please try again.'

export interface TaskReconcilerOptions {
  readonly a2aTaskTracker: A2aTaskTracker
  readonly remoteAgentRegistry: RemoteAgentRegistry
  // The same finalizer the push notification path uses, so a poll that
  // observes a decided task settles and posts through the exact same logic
  // (terminal settle / input-required question / heartbeat refresh).
  readonly responseFinalizer: ResponseFinalizer
  readonly eventLogStore: EventLogStore
  readonly slackClient: SlackWebClient
  readonly graceMs?: number | undefined
  readonly intervalMs?: number | undefined
  readonly retentionMs?: number | undefined
  readonly now?: (() => Date) | undefined
  readonly setIntervalImpl?:
    ((callback: () => void, ms: number) => NodeJS.Timeout) | undefined
  readonly clearIntervalImpl?: ((handle: NodeJS.Timeout) => void) | undefined
  readonly inFlightTasks?: Pick<InFlightTasks, 'track'> | undefined
  readonly logger?: Logger | undefined
}

export interface TaskReconcilerResult {
  // Rows the reconciler itself decided the outcome for this tick: a
  // deadline-forced failure, a TaskNotFound-forced failure, or a poll that
  // observed a terminal state. Excludes no-op observations (heartbeat,
  // input-required, still-active).
  readonly settled: number
  readonly pruned: number
}

export interface TaskReconcilerHandle {
  stop(): void
  runOnce(): Promise<TaskReconcilerResult>
}

export const startTaskReconciler = (
  options: TaskReconcilerOptions,
): TaskReconcilerHandle => {
  const logger = options.logger ?? noopLogger
  const graceMs = options.graceMs ?? TASK_RECONCILER_DEFAULT_GRACE_MS
  const intervalMs = options.intervalMs ?? TASK_RECONCILER_DEFAULT_INTERVAL_MS
  const retentionMs =
    options.retentionMs ?? TASK_RECONCILER_DEFAULT_RETENTION_MS
  const now = options.now ?? (() => new Date())
  const setIntervalImpl = options.setIntervalImpl ?? setInterval
  const clearIntervalImpl = options.clearIntervalImpl ?? clearInterval

  const postToThread = async (
    row: A2aTaskRow,
    text: string,
  ): Promise<boolean> => {
    try {
      await postThreadMessage(
        options.slackClient,
        { channel: row.slackChannelId, threadTs: row.threadRootTs },
        text,
      )
      return true
    } catch (error) {
      logger.error(
        {
          event: 'llm_agent_a2a_reconcile_post_failed',
          task_id: row.taskId,
          agent_name: row.agentName,
          err: error,
        },
        'llm-agent reconciler failed to post a forced-failure result to Slack',
      )
      return false
    }
  }

  // Settles a row the reconciler itself decided to fail (deadline exceeded,
  // or the remote task purged): neither case has a Task payload for
  // ResponseFinalizer.finalizeTask to build a message from, so this mirrors
  // its settleTerminal instead. The caller's transition() already elected
  // this call the winner, so a Slack post failure here rolls the settled
  // flag back for a later retry rather than losing the outcome silently.
  // Returns whether this call actually settled the row: false when the
  // Slack post failed and got rolled back, so the caller doesn't count a
  // tick that will need to retry as if it had decided the outcome.
  const settleFailure = async (
    row: A2aTaskRow,
    reason: A2aReconcilerSettledReason,
    text: string,
  ): Promise<boolean> => {
    const posted = await postToThread(row, text)
    if (!posted) {
      try {
        await options.a2aTaskTracker.unsettle(row.taskId)
      } catch (error) {
        logger.error(
          {
            event: 'llm_agent_a2a_reconcile_unsettle_failed',
            task_id: row.taskId,
            err: error,
          },
          'llm-agent reconciler failed to roll back the settled flag after a Slack post failure',
        )
      }
      return false
    }
    try {
      await options.eventLogStore.markResponded(row.slackEventId)
    } catch (error) {
      logger.warn(
        {
          event: 'llm_agent_a2a_reconcile_mark_responded_failed',
          task_id: row.taskId,
          slack_event_id: row.slackEventId,
          err: error,
        },
        'llm-agent reconciler failed to mark event_log responded after a forced-failure settle',
      )
    }
    recordA2aTaskSettled(row.agentName, 'failed')
    recordA2aReconcilerSettled(reason)
    return true
  }

  // Returns true when this tick itself decided the row's outcome (deadline
  // failure, TaskNotFound failure, or a poll that observed a terminal
  // state), for the tick's `settled` count.
  const reconcileRow = async (row: A2aTaskRow): Promise<boolean> => {
    const deadline = now()
    if (
      A2A_TASK_ACTIVE_EXECUTION_STATES.includes(row.state) &&
      row.deadlineAt.getTime() <= deadline.getTime()
    ) {
      const { updated } = await options.a2aTaskTracker.transition(row.taskId, {
        state: 'failed',
        ifDeadlineAtOrBefore: deadline,
      })
      if (updated) {
        return settleFailure(row, 'deadline', DEADLINE_EXCEEDED_TEXT)
      }
    }

    const handles = await options.remoteAgentRegistry.listAgents()
    const handle = handles.find((h) => h.name === row.agentName)
    if (handle === undefined) {
      logger.warn(
        {
          event: 'llm_agent_a2a_reconcile_agent_not_found',
          task_id: row.taskId,
          agent_name: row.agentName,
        },
        'llm-agent reconciler could not poll a task: its remote agent is no longer registered',
      )
      return false
    }

    let task: Task
    try {
      task = await handle.client.getTask({ id: row.taskId })
    } catch (error) {
      if (error instanceof TaskNotFoundError) {
        // The default 'failed' guard only permits submitted/working rows,
        // so an input-required row needs requireCurrentStates to opt back
        // in; without it, a TaskNotFound observed here would leave that
        // row unsettled (and un-pruned) forever, since no other path
        // re-polls it once the user has stopped replying.
        const { updated } = await options.a2aTaskTracker.transition(
          row.taskId,
          row.state === 'input-required'
            ? { state: 'failed', requireCurrentStates: ['input-required'] }
            : { state: 'failed' },
        )
        if (updated) {
          return settleFailure(row, 'polling', TASK_NOT_FOUND_TEXT)
        }
        return false
      }
      logger.warn(
        {
          event: 'llm_agent_a2a_reconcile_poll_failed',
          task_id: row.taskId,
          agent_name: row.agentName,
          err: error,
        },
        'llm-agent reconciler failed to poll tasks/get for an unsettled task',
      )
      return false
    }

    // Delegates the actual settle/post decision to the same finalizer the
    // push notification path uses, so a missed push and a reconciler poll
    // produce identical behavior. finalizeTask takes the Task this call
    // already fetched instead of re-fetching it itself, and (since no push
    // was received) does not record a push-notification counter for it.
    // Its returned outcome — not a re-query of the row — decides the count,
    // since a concurrent push notification racing this same poll can settle
    // the row first, in which case finalizeTask reports 'duplicate' even
    // though the row is now settled.
    const outcome = await options.responseFinalizer.finalizeTask(row, task)
    if (outcome === 'settled') {
      recordA2aReconcilerSettled('polling')
      return true
    }
    return false
  }

  // Guards against overlapping ticks: a slow DB/Slack/remote-agent call must
  // not let concurrent runs pile up against the same rows.
  let isRunning = false

  const runOnce = async (): Promise<TaskReconcilerResult> => {
    if (isRunning) return { settled: 0, pruned: 0 }
    isRunning = true
    try {
      let rows: readonly A2aTaskRow[]
      try {
        rows = await options.a2aTaskTracker.findUnsettled(
          new Date(now().getTime() - graceMs),
        )
      } catch (error) {
        logger.error(
          { event: 'llm_agent_a2a_reconcile_query_failed', err: error },
          'llm-agent reconciler failed to query unsettled a2a_task rows',
        )
        rows = []
      }

      let settled = 0
      for (const row of rows) {
        try {
          if (await reconcileRow(row)) settled++
        } catch (error) {
          logger.error(
            {
              event: 'llm_agent_a2a_reconcile_row_failed',
              task_id: row.taskId,
              err: error,
            },
            'llm-agent reconciler failed to reconcile an unsettled a2a_task row',
          )
        }
      }

      let pruned = 0
      try {
        pruned = await options.a2aTaskTracker.deleteSettledOlderThan(
          new Date(now().getTime() - retentionMs),
        )
      } catch (error) {
        logger.error(
          { event: 'llm_agent_a2a_reconcile_prune_failed', err: error },
          'llm-agent reconciler failed to prune settled a2a_task rows',
        )
      }

      return { settled, pruned }
    } finally {
      isRunning = false
    }
  }

  // Wraps every runOnce() invocation so a graceful-shutdown drain also
  // covers whichever run is in progress, not just the live dispatch path.
  const trackedRunOnce = (): Promise<TaskReconcilerResult> => {
    const result = runOnce()
    void options.inFlightTasks?.track(result)
    return result
  }

  const timer = setIntervalImpl(() => {
    void trackedRunOnce()
  }, intervalMs)
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    ;(timer as { unref: () => void }).unref()
  }

  return {
    stop() {
      clearIntervalImpl(timer)
    },
    runOnce: trackedRunOnce,
  }
}
