import { errAsync, okAsync, type ResultAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import { startEventLogRetention } from '#plugins/llm-agent/event-log-retention'
import type { EventLogStore } from '#plugins/llm-agent/event-log-store'
import { EventLogStoreError } from '#types/errors'

const createStore = (
  pruneImpl: (cutoff: Date) => ResultAsync<number, EventLogStoreError> = () =>
    okAsync(0),
): EventLogStore => ({
  recordReceived: vi.fn(),
  deleteReceived: vi.fn(),
  markTaskName: vi.fn(() => okAsync({ updated: 0 })),
  findByTaskName: vi.fn(() => okAsync(undefined)),
  findDispatchedUnresponded: vi.fn(() => okAsync([])),
  markResponded: vi.fn(() => okAsync({ updated: 0 })),
  unmarkResponded: vi.fn(() => okAsync({ updated: 0 })),
  pruneOlderThan: vi.fn(pruneImpl),
  hasAcceptedSibling: vi.fn(() => okAsync(false)),
})

const createDefaultRetentionHarness = () => {
  const prune = vi.fn<
    (cutoff: Date) => ResultAsync<number, EventLogStoreError>
  >(() => okAsync(0))
  const intervals: number[] = []
  const handle = startEventLogRetention({
    eventLogStore: createStore(prune),
    now: () => 10_000,
    setIntervalImpl: (_callback, intervalMs) => {
      intervals.push(intervalMs)
      return {} as NodeJS.Timeout
    },
    clearIntervalImpl: () => {},
  })

  return { prune, intervals, handle }
}

describe('startEventLogRetention', () => {
  it('runOnce calls pruneOlderThan with now - ttlMs and returns the removed count', async () => {
    const prune = vi.fn((): ResultAsync<number, EventLogStoreError> =>
      okAsync(3),
    )
    const store = { ...createStore(), pruneOlderThan: prune }
    const handle = startEventLogRetention({
      eventLogStore: store,
      ttlMs: 1000,
      intervalMs: 60_000,
      now: () => 10_000,
      setIntervalImpl: () => ({}) as unknown as NodeJS.Timeout,
      clearIntervalImpl: () => {},
    })

    await expect(handle.runOnce()).resolves.toBe(3)
    expect(prune.mock.calls).toEqual([[new Date(9_000)]])
  })

  it('swallows pruneOlderThan errors and returns 0', async () => {
    const prune = vi.fn((): ResultAsync<number, EventLogStoreError> =>
      errAsync(new EventLogStoreError('db down')),
    )
    const store = { ...createStore(), pruneOlderThan: prune }
    const handle = startEventLogRetention({
      eventLogStore: store,
      ttlMs: 1000,
      intervalMs: 60_000,
      now: () => 10_000,
      setIntervalImpl: () => ({}) as unknown as NodeJS.Timeout,
      clearIntervalImpl: () => {},
    })

    await expect(handle.runOnce()).resolves.toBe(0)
  })

  it('schedules the pruner on the requested interval and stop clears it', () => {
    const fakeTimer = Symbol('timer') as unknown as NodeJS.Timeout
    const setIntervalImpl = vi.fn<
      (callback: () => void, ms: number) => NodeJS.Timeout
    >(() => fakeTimer)
    const clearIntervalImpl = vi.fn<(handle: NodeJS.Timeout) => void>()
    const handle = startEventLogRetention({
      eventLogStore: createStore(),
      ttlMs: 1000,
      intervalMs: 12_345,
      setIntervalImpl,
      clearIntervalImpl,
    })

    expect(setIntervalImpl.mock.calls.map((args) => args[1])).toEqual([12_345])

    handle.stop()
    expect(clearIntervalImpl.mock.calls).toEqual([[fakeTimer]])
  })

  it('uses a one-hour default prune interval', () => {
    const { intervals, handle } = createDefaultRetentionHarness()
    handle.stop()

    expect(intervals).toEqual([60 * 60 * 1000])
  })

  it('uses a seven-day default ttl when pruning', async () => {
    const { prune, handle } = createDefaultRetentionHarness()
    await handle.runOnce()
    handle.stop()

    expect(prune.mock.calls).toEqual([
      [new Date(10_000 - 7 * 24 * 60 * 60 * 1000)],
    ])
  })
})
