import type { EventLogRow } from '@/plugins/llm-agent/event-log-store'
import type {
  ProcessMentionDeps,
  SlackEnvelope,
} from '@/plugins/llm-agent/process-mention-deps'
import { resolveDeps } from '@/plugins/llm-agent/process-mention-deps'
import { respond } from '@/plugins/llm-agent/steps/respond'
import { terminalOutcomeForTaskCrStatus } from '@/plugins/llm-agent/steps/wait-for-completion'
import type { TaskCrStatus } from '@/plugins/llm-agent/task-cr-client'
import type { InFlightTasks } from '@/server/in-flight-tasks'

// Grace period, measured from Slack event receipt (not from dispatch, which
// event_log does not timestamp separately), before a dispatched-but-
// unresponded row becomes a reconciliation candidate. This only reduces how
// often the reconciler redundantly re-derives a response for a task the live
// dispatch path is still in the middle of; it is not what prevents a double
// Slack post — respond()'s event_log markResponded does that regardless of
// how many times a row gets reconciled.
export const RESPONSE_RECONCILER_DEFAULT_GRACE_MS = 2 * 60 * 1000
export const RESPONSE_RECONCILER_DEFAULT_INTERVAL_MS = 60 * 1000

export interface ResponseReconcilerOptions extends ProcessMentionDeps {
  readonly graceMs?: number | undefined
  readonly intervalMs?: number | undefined
  readonly now?: (() => number) | undefined
  readonly setIntervalImpl?:
    | ((callback: () => void, ms: number) => NodeJS.Timeout)
    | undefined
  readonly clearIntervalImpl?: ((handle: NodeJS.Timeout) => void) | undefined
  readonly inFlightTasks?: Pick<InFlightTasks, 'track'> | undefined
}

export interface ResponseReconcilerHandle {
  stop(): void
  runOnce(): Promise<number>
}

// text/images are only consumed by submitTask, which already ran on the Pod
// that originally dispatched this Task; waitForCompletion/respond never
// read them, so placeholders are safe here.
const envelopeFromRow = (row: EventLogRow): SlackEnvelope | undefined => {
  if (
    row.slackTeamId === undefined ||
    row.slackChannelId === undefined ||
    row.threadRootTs === undefined
  ) {
    return undefined
  }
  return {
    eventId: row.slackEventId,
    teamId: row.slackTeamId,
    channelId: row.slackChannelId,
    threadRootTs: row.threadRootTs,
    text: '',
    images: [],
  }
}

export const startResponseReconciler = (
  options: ResponseReconcilerOptions,
): ResponseReconcilerHandle => {
  const resolved = resolveDeps(options)
  const logger = resolved.logger
  const graceMs = options.graceMs ?? RESPONSE_RECONCILER_DEFAULT_GRACE_MS
  const intervalMs =
    options.intervalMs ?? RESPONSE_RECONCILER_DEFAULT_INTERVAL_MS
  const now = options.now ?? (() => Date.now())
  const setIntervalImpl = options.setIntervalImpl ?? setInterval
  const clearIntervalImpl = options.clearIntervalImpl ?? clearInterval

  const reconcileRow = async (
    row: EventLogRow,
    statusByName: ReadonlyMap<string, TaskCrStatus>,
  ): Promise<boolean> => {
    const taskName = row.taskName
    if (taskName === undefined) return false

    const status = statusByName.get(taskName)
    if (status === undefined) {
      // A missing Task CR (e.g. deleted by an operator) can never reach a
      // terminal phase again, so mark the row responded to drop it from
      // findDispatchedUnresponded — otherwise it would warn on every tick
      // for the rest of its 7-day event_log retention.
      logger.warn(
        {
          event: 'llm_agent_response_reconcile_task_cr_missing',
          task_name: taskName,
          slack_event_id: row.slackEventId,
        },
        'llm-agent reconciler found no Task CR for an unresponded event_log row; giving up and marking it responded',
      )
      await resolved.eventLogStore.markResponded(row.slackEventId)
      return false
    }

    const outcome = terminalOutcomeForTaskCrStatus(status)
    if (outcome === undefined) return false

    const env = envelopeFromRow(row)
    if (env === undefined) {
      logger.warn(
        {
          event: 'llm_agent_response_reconcile_missing_envelope_fields',
          task_name: taskName,
          slack_event_id: row.slackEventId,
        },
        'llm-agent reconciler found an unresponded event_log row missing envelope fields',
      )
      return false
    }

    logger.info(
      {
        event: 'llm_agent_response_reconcile_attempt',
        task_name: taskName,
        slack_event_id: row.slackEventId,
        phase: outcome.kind,
      },
      'llm-agent reconciler recovering a Task response a dead Pod never delivered',
    )
    const { posted } = await respond(env, taskName, outcome, options)
    return posted
  }

  // Guards against overlapping ticks: setInterval fires on a fixed cadence
  // regardless of how long the previous runOnce() is still taking (slow DB,
  // Kubernetes API, or Slack/opencode calls), so without this a slow run
  // would pile up concurrent runs against the same rows.
  let isRunning = false

  const runOnce = async (): Promise<number> => {
    if (isRunning) return 0
    isRunning = true
    try {
      let rows: readonly EventLogRow[]
      try {
        rows = await resolved.eventLogStore.findDispatchedUnresponded(
          new Date(now() - graceMs),
        )
      } catch (error) {
        logger.error(
          {
            event: 'llm_agent_response_reconcile_query_failed',
            err: error,
          },
          'llm-agent reconciler failed to query dispatched-but-unresponded event_log rows',
        )
        return 0
      }
      if (rows.length === 0) return 0

      let statuses: readonly TaskCrStatus[]
      try {
        statuses = await resolved.taskCrClient.list(resolved.namespace)
      } catch (error) {
        logger.error(
          {
            event: 'llm_agent_response_reconcile_list_failed',
            namespace: resolved.namespace,
            err: error,
          },
          'llm-agent reconciler failed to list Task CRs',
        )
        return 0
      }
      const statusByName = new Map(statuses.map((s) => [s.name, s] as const))

      let recovered = 0
      for (const row of rows) {
        try {
          if (await reconcileRow(row, statusByName)) recovered++
        } catch (error) {
          logger.error(
            {
              event: 'llm_agent_response_reconcile_respond_failed',
              task_name: row.taskName,
              slack_event_id: row.slackEventId,
              err: error,
            },
            'llm-agent reconciler failed to recover a Task response',
          )
        }
      }
      return recovered
    } finally {
      isRunning = false
    }
  }

  // Wraps every runOnce() invocation — both the interval tick below and the
  // handle returned to callers — so a graceful-shutdown drain also covers
  // whichever run is in progress, not just the live dispatch path.
  const trackedRunOnce = (): Promise<number> => {
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
