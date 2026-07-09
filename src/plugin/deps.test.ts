import { describe, expect, it, vi } from 'vitest'

import type { PluginDeps } from '@/plugin/deps'
import { resolvePlugin } from '@/plugin/deps'
import type { Plugin } from '@/plugin/plugin'

const stubDeps = (): PluginDeps =>
  ({
    config: {} as PluginDeps['config'],
    logger: {} as PluginDeps['logger'],
    slackClient: {} as PluginDeps['slackClient'],
    scheduler: {} as PluginDeps['scheduler'],
    cfAccess: {} as PluginDeps['cfAccess'],
    eventLogStore: {} as PluginDeps['eventLogStore'],
    threadSessionStore: {} as PluginDeps['threadSessionStore'],
    inFlightTasks: {} as PluginDeps['inFlightTasks'],
  }) satisfies PluginDeps

describe('resolvePlugin', () => {
  it('returns a plain plugin object as-is', () => {
    const plugin: Plugin = { name: 'p', commands: [] }
    expect(resolvePlugin(plugin, stubDeps())).toBe(plugin)
  })

  it('invokes a factory with the deps and returns the produced plugin', () => {
    const factory = vi.fn((deps: PluginDeps): Plugin => ({
      name: 'factory-built',
      commands: [],
      async onCommand(ctx) {
        // touch deps to assert they are accessible inside the factory closure
        ctx.ack()
        deps.scheduler.listActive()
      },
    }))
    const deps = stubDeps()
    const plugin = resolvePlugin(factory, deps)
    expect(plugin.name).toBe('factory-built')
    expect(factory).toHaveBeenCalledWith(deps)
  })
})
