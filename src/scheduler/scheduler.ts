import { ResultAsync } from 'neverthrow'

import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import {
  SchedulerDuplicateNameError,
  SchedulerInvalidArgumentError,
  SchedulerLimitError,
} from '@/types/errors'

export type TaskTickResult = { done: false } | { done: true }

export interface ScheduledTaskDef {
  readonly name: string
  readonly intervalMs: number
  readonly maxDurationMs: number
  readonly tick: () => Promise<TaskTickResult>
  readonly onTimeout?: () => Promise<void>
  readonly onError?: (err: unknown) => Promise<void>
}

export type TaskStatus = 'running' | 'completed' | 'timed-out' | 'cancelled'

export interface TaskHandle {
  readonly name: string
  readonly status: TaskStatus
  cancel(): void
}

export interface InMemoryScheduler {
  schedule(def: ScheduledTaskDef): TaskHandle
  listActive(): readonly TaskHandle[]
}

export interface SchedulerOptions {
  readonly maxConcurrentTasks: number
  readonly logger?: Logger | undefined
  readonly setTimeoutImpl?:
    ((callback: () => void, ms: number) => NodeJS.Timeout) | undefined
  readonly clearTimeoutImpl?: ((handle: NodeJS.Timeout) => void) | undefined
  readonly now?: (() => number) | undefined
}

const MIN_INTERVAL_MS = 1000

const toResult = <T>(promise: Promise<T>): ResultAsync<T, unknown> =>
  ResultAsync.fromPromise(promise, (err) => err)

export const createScheduler = (
  options: SchedulerOptions,
): InMemoryScheduler => {
  const logger = options.logger ?? noopLogger
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout
  const now = options.now ?? (() => Date.now())

  interface RunningTask {
    handle: MutableHandle
    timer: NodeJS.Timeout | undefined
    startedAt: number
    def: ScheduledTaskDef
  }

  const tasks = new Map<string, RunningTask>()

  const isRunning = (state: RunningTask): boolean => tasks.has(state.def.name)

  const transition = (
    state: RunningTask,
    nextStatus: Exclude<TaskStatus, 'running'>,
  ): void => {
    if (!isRunning(state)) return
    state.handle.status = nextStatus
    if (state.timer !== undefined) {
      clearTimeoutImpl(state.timer)
      state.timer = undefined
    }
    tasks.delete(state.def.name)
  }

  const run = async (state: RunningTask): Promise<void> => {
    if (!isRunning(state)) return
    if (now() - state.startedAt > state.def.maxDurationMs) {
      transition(state, 'timed-out')
      if (state.def.onTimeout !== undefined) {
        const result = await toResult(state.def.onTimeout())
        if (result.isErr()) {
          logger.error(
            {
              event: 'scheduler_timeout_handler_error',
              task: state.def.name,
              error: serializeError(result.error),
            },
            'scheduler onTimeout handler threw',
          )
        }
      }
      return
    }
    const tickResult = await toResult(state.def.tick())
    if (!isRunning(state)) return
    if (tickResult.isOk()) {
      if (tickResult.value.done) {
        transition(state, 'completed')
        return
      }
    } else {
      const err = tickResult.error
      if (state.def.onError !== undefined) {
        const onErrorResult = await toResult(state.def.onError(err))
        if (onErrorResult.isErr()) {
          logger.error(
            {
              event: 'scheduler_error_handler_error',
              task: state.def.name,
              error: serializeError(onErrorResult.error),
            },
            'scheduler onError handler threw',
          )
        }
      } else {
        logger.error(
          {
            event: 'scheduler_task_error',
            task: state.def.name,
            error: serializeError(err),
          },
          'scheduler task tick threw',
        )
      }
    }
    if (isRunning(state)) {
      schedule(state)
    }
  }

  const schedule = (state: RunningTask): void => {
    state.timer = setTimeoutImpl(() => {
      void run(state)
    }, state.def.intervalMs)
  }

  return {
    // Left as throw, matching the fail-fast invariant-violation convention
    // used by registry.ts's register() and config.ts's loadConfig() for
    // programmer errors caught at registration/startup time rather than
    // runtime failures of external calls.
    schedule(def) {
      if (def.intervalMs < MIN_INTERVAL_MS) {
        throw new SchedulerInvalidArgumentError(
          `intervalMs must be >= ${String(MIN_INTERVAL_MS)} (got ${String(def.intervalMs)})`,
        )
      }
      if (def.maxDurationMs <= 0) {
        throw new SchedulerInvalidArgumentError(
          `maxDurationMs must be > 0 (got ${String(def.maxDurationMs)})`,
        )
      }
      if (tasks.has(def.name)) {
        throw new SchedulerDuplicateNameError(def.name)
      }
      if (tasks.size >= options.maxConcurrentTasks) {
        throw new SchedulerLimitError(options.maxConcurrentTasks)
      }
      const handle = createMutableHandle(def.name, () => {
        const state = tasks.get(def.name)
        if (state === undefined) return
        transition(state, 'cancelled')
      })
      const state: RunningTask = {
        handle,
        timer: undefined,
        startedAt: now(),
        def,
      }
      tasks.set(def.name, state)
      schedule(state)
      return handle
    },
    listActive() {
      return Array.from(tasks.values()).map((t) => t.handle)
    },
  }
}

interface MutableHandle {
  readonly name: string
  status: TaskStatus
  cancel(): void
}

const createMutableHandle = (
  name: string,
  cancel: () => void,
): MutableHandle => {
  const initial: TaskStatus = 'running'
  return { name, status: initial, cancel }
}

const serializeError = (err: unknown): Record<string, unknown> => {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack }
  }
  return { value: String(err) }
}
