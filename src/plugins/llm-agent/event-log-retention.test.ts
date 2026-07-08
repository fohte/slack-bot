import { describe, expect, it, vi } from 'vitest'

import {
  EVENT_LOG_DEFAULT_PRUNE_INTERVAL_MS,
  EVENT_LOG_DEFAULT_TTL_MS,
  startEventLogRetention,
} from '@/plugins/llm-agent/event-log-retention'
import type { EventLogStore } from '@/plugins/llm-agent/event-log-store'

const createStore = (
  pruneImpl: (cutoff: Date) => Promise<number> = async () => 0,
): EventLogStore => ({
  recordReceived: vi.fn(),
  deleteReceived: vi.fn(),
  markTaskName: vi.fn(async () => ({ updated: 0 })),
  findByTaskName: vi.fn(async () => undefined),
  markResponded: vi.fn(async () => ({ updated: 0 })),
  unmarkResponded: vi.fn(async () => ({ updated: 0 })),
  pruneOlderThan: vi.fn(pruneImpl),
  hasAcceptedSibling: vi.fn(async () => false),
})

describe('startEventLogRetention', () => {
  it('runOnce calls pruneOlderThan with now - ttlMs and returns the removed count', async () => {
    const prune = vi.fn(async (): Promise<number> => 3)
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
    const prune = vi.fn(async () => {
      throw new Error('db down')
    })
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

  it('exposes default ttl and interval constants used when options are omitted', () => {
    expect({
      ttlMs: EVENT_LOG_DEFAULT_TTL_MS,
      intervalMs: EVENT_LOG_DEFAULT_PRUNE_INTERVAL_MS,
    }).toEqual({
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      intervalMs: 60 * 60 * 1000,
    })
  })
})
