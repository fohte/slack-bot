import { describe, expect, it } from 'vitest'

import { createInFlightTurnRegistry } from '#plugins/llm-agent/in-flight-turns'

describe('createInFlightTurnRegistry', () => {
  it('reports a key as in flight after start() and not after finish()', () => {
    const registry = createInFlightTurnRegistry()
    const key = { channelId: 'C1', ts: '111.222' }

    expect(registry.has(key)).toBe(false)
    registry.start(key)
    expect(registry.has(key)).toBe(true)
    registry.finish(key)
    expect(registry.has(key)).toBe(false)
  })

  it('distinguishes keys by channel and ts independently', () => {
    const registry = createInFlightTurnRegistry()
    registry.start({ channelId: 'C1', ts: '111.222' })

    expect(registry.has({ channelId: 'C2', ts: '111.222' })).toBe(false)
    expect(registry.has({ channelId: 'C1', ts: '333.444' })).toBe(false)
    expect(registry.has({ channelId: 'C1', ts: '111.222' })).toBe(true)
  })

  it('treats finish() for a key that was never started as a no-op', () => {
    const registry = createInFlightTurnRegistry()
    const key = { channelId: 'C1', ts: '111.222' }

    registry.finish(key)

    expect(registry.has(key)).toBe(false)
  })
})
