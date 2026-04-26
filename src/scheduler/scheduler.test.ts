import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createScheduler } from '@/scheduler/scheduler'
import {
  SchedulerDuplicateNameError,
  SchedulerInvalidArgumentError,
  SchedulerLimitError,
} from '@/types/errors'

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('InMemoryScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('invokes tick after intervalMs and stops on done:true', async () => {
    const tick = vi
      .fn()
      .mockResolvedValueOnce({ done: false })
      .mockResolvedValue({ done: true })
    const scheduler = createScheduler({ maxConcurrentTasks: 8 })
    const handle = scheduler.schedule({
      name: 'task-1',
      intervalMs: 1000,
      maxDurationMs: 60_000,
      tick,
    })

    await vi.advanceTimersByTimeAsync(1000)
    expect(tick).toHaveBeenCalledTimes(1)
    expect(handle.status).toBe('running')

    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(tick).toHaveBeenCalledTimes(2)
    expect(handle.status).toBe('completed')
    expect(scheduler.listActive()).toHaveLength(0)
  })

  it('triggers onTimeout when maxDurationMs is exceeded', async () => {
    let nowVal = 0
    const onTimeout = vi.fn().mockResolvedValue(undefined)
    const scheduler = createScheduler({
      maxConcurrentTasks: 8,
      now: () => nowVal,
    })
    scheduler.schedule({
      name: 'timeout-task',
      intervalMs: 1000,
      maxDurationMs: 1500,
      tick: vi.fn().mockResolvedValue({ done: false }),
      onTimeout,
    })

    nowVal = 1100
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(onTimeout).not.toHaveBeenCalled()

    nowVal = 2200
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(scheduler.listActive()).toHaveLength(0)
  })

  it('rejects intervals below 1000ms', () => {
    const scheduler = createScheduler({ maxConcurrentTasks: 8 })
    expect(() =>
      scheduler.schedule({
        name: 'bad',
        intervalMs: 500,
        maxDurationMs: 5000,
        tick: vi.fn(),
      }),
    ).toThrow(SchedulerInvalidArgumentError)
  })

  it('throws when concurrent task limit is exceeded', () => {
    const scheduler = createScheduler({ maxConcurrentTasks: 1 })
    scheduler.schedule({
      name: 'a',
      intervalMs: 1000,
      maxDurationMs: 60_000,
      tick: vi.fn().mockResolvedValue({ done: false }),
    })
    expect(() =>
      scheduler.schedule({
        name: 'b',
        intervalMs: 1000,
        maxDurationMs: 60_000,
        tick: vi.fn().mockResolvedValue({ done: false }),
      }),
    ).toThrow(SchedulerLimitError)
  })

  it('rejects duplicate task names', () => {
    const scheduler = createScheduler({ maxConcurrentTasks: 8 })
    scheduler.schedule({
      name: 'dup',
      intervalMs: 1000,
      maxDurationMs: 60_000,
      tick: vi.fn().mockResolvedValue({ done: false }),
    })
    expect(() =>
      scheduler.schedule({
        name: 'dup',
        intervalMs: 1000,
        maxDurationMs: 60_000,
        tick: vi.fn().mockResolvedValue({ done: false }),
      }),
    ).toThrow(SchedulerDuplicateNameError)
  })

  it('cancel stops the task', async () => {
    const tick = vi.fn().mockResolvedValue({ done: false })
    const scheduler = createScheduler({ maxConcurrentTasks: 8 })
    const handle = scheduler.schedule({
      name: 'cancellable',
      intervalMs: 1000,
      maxDurationMs: 60_000,
      tick,
    })
    handle.cancel()
    expect(handle.status).toBe('cancelled')
    await vi.advanceTimersByTimeAsync(5000)
    expect(tick).not.toHaveBeenCalled()
    expect(scheduler.listActive()).toHaveLength(0)
  })

  it('invokes onError when tick throws and continues running', async () => {
    const onError = vi.fn().mockResolvedValue(undefined)
    const tick = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ done: true })
    const scheduler = createScheduler({ maxConcurrentTasks: 8 })
    scheduler.schedule({
      name: 'err',
      intervalMs: 1000,
      maxDurationMs: 60_000,
      tick,
      onError,
    })
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(onError).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(tick).toHaveBeenCalledTimes(2)
  })
})
