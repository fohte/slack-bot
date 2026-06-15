import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import type { TaskResponseHandler } from '@/plugins/llm-agent/response-handler'
import type {
  TaskCrClient,
  TaskCrStatus,
} from '@/plugins/llm-agent/task-cr-client'

export const DEFAULT_TASK_WATCH_INTERVAL_MS = 5000

export type TaskPhaseTransitionHandler = (
  task: TaskCrStatus,
) => Promise<void> | void

export interface TaskCrWatcherOptions {
  readonly taskCrClient: TaskCrClient
  readonly handler: TaskResponseHandler
  readonly namespace: string
  readonly onPhaseTransition?: TaskPhaseTransitionHandler | undefined
  readonly intervalMs?: number | undefined
  readonly logger?: Logger | undefined
  readonly setIntervalImpl?:
    | ((callback: () => void, ms: number) => NodeJS.Timeout)
    | undefined
  readonly clearIntervalImpl?: ((handle: NodeJS.Timeout) => void) | undefined
}

export interface TaskCrWatcherHandle {
  stop(): void
  runOnce(): Promise<number>
}

export const startTaskCrWatcher = (
  options: TaskCrWatcherOptions,
): TaskCrWatcherHandle => {
  const logger = options.logger ?? noopLogger
  const intervalMs = options.intervalMs ?? DEFAULT_TASK_WATCH_INTERVAL_MS
  const setIntervalImpl = options.setIntervalImpl ?? setInterval
  const clearIntervalImpl = options.clearIntervalImpl ?? clearInterval
  const { taskCrClient, handler, namespace, onPhaseTransition } = options

  const lastPhases = new Map<string, string | undefined>()
  let running = false

  const runOnce = async (): Promise<number> => {
    if (running) {
      // Skip overlapping ticks; an overrun tick would only duplicate work,
      // never recover faster.
      return 0
    }
    running = true
    try {
      let tasks
      try {
        tasks = await taskCrClient.list(namespace)
      } catch (error) {
        logger.error(
          {
            event: 'llm_agent_task_watch_list_failed',
            namespace,
            err: error,
          },
          'task watcher failed to list Task CRs',
        )
        return 0
      }
      // Drop entries for tasks no longer present in the cluster so the
      // map cannot grow unbounded when CRs are deleted without first
      // reaching a terminal phase.
      const activeNames = new Set(tasks.map((t) => t.name))
      for (const name of lastPhases.keys()) {
        if (!activeNames.has(name)) lastPhases.delete(name)
      }

      let respondedCount = 0
      for (const task of tasks) {
        if (onPhaseTransition !== undefined) {
          const previous = lastPhases.get(task.name)
          if (previous !== task.phase) {
            try {
              await onPhaseTransition(task)
              // Record only after success so a failed transition re-fires
              // on the next tick instead of being silently swallowed.
              lastPhases.set(task.name, task.phase)
            } catch (error) {
              logger.error(
                {
                  event: 'llm_agent_task_watch_phase_transition_failed',
                  task_name: task.name,
                  namespace: task.namespace,
                  phase: task.phase,
                  err: error,
                },
                'task watcher phase transition handler threw',
              )
            }
          }
        }

        if (task.phase !== 'Completed' && task.phase !== 'Failed') continue
        try {
          const outcome = await handler(task)
          if (outcome === 'responded') respondedCount += 1
        } catch (error) {
          logger.error(
            {
              event: 'llm_agent_task_watch_handler_failed',
              task_name: task.name,
              namespace: task.namespace,
              err: error,
            },
            'task watcher handler threw',
          )
        }
      }
      return respondedCount
    } finally {
      running = false
    }
  }

  const timer = setIntervalImpl(() => {
    void runOnce()
  }, intervalMs)
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    ;(timer as { unref: () => void }).unref()
  }

  logger.info(
    {
      event: 'llm_agent_task_watch_started',
      namespace,
      interval_ms: intervalMs,
    },
    'llm-agent Task CR watcher started',
  )

  return {
    stop() {
      clearIntervalImpl(timer)
    },
    runOnce,
  }
}
