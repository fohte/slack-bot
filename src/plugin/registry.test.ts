import { describe, expect, it } from 'vitest'

import type { Plugin } from '@/plugin/plugin'
import { createPluginRegistry } from '@/plugin/registry'
import {
  PluginInvalidNameError,
  PluginNameConflictError,
  SlashCommandConflictError,
} from '@/types/errors'

const samplePlugin = (overrides: Partial<Plugin> = {}): Plugin => ({
  name: 'crawl',
  commands: [
    { command: '/crawl-list', description: 'List crawlers' },
    { command: '/crawl-run', description: 'Run a crawler' },
  ],
  ...overrides,
})

describe('PluginRegistry', () => {
  it('registers plugins and looks up by command name', () => {
    const registry = createPluginRegistry()
    const plugin = samplePlugin()
    registry.register(plugin)
    expect(registry.lookupCommand('/crawl-list')?.name).toBe('crawl')
    expect(registry.lookupCommand('/crawl-run')?.name).toBe('crawl')
    expect(registry.lookupCommand('/unknown')).toBeUndefined()
  })

  it('looks up by action_id / callback_id prefix', () => {
    const registry = createPluginRegistry()
    registry.register(samplePlugin())
    expect(registry.lookupByActionOrCallbackId('crawl:start:42')?.name).toBe(
      'crawl',
    )
    expect(registry.lookupByActionOrCallbackId('blog:foo')).toBeUndefined()
    expect(registry.lookupByActionOrCallbackId(':orphan')).toBeUndefined()
  })

  it('throws when plugin name is invalid', () => {
    const registry = createPluginRegistry()
    const tryRegister = (name: string) => () => {
      registry.register(samplePlugin({ name }))
    }
    expect(tryRegister('BadName')).toThrow(PluginInvalidNameError)
    expect(tryRegister('0starts-digit')).toThrow(PluginInvalidNameError)
    expect(tryRegister('')).toThrow(PluginInvalidNameError)
  })

  it('throws on duplicate plugin name', () => {
    const registry = createPluginRegistry()
    registry.register(samplePlugin())
    expect(() => {
      registry.register(samplePlugin({ commands: [] }))
    }).toThrow(PluginNameConflictError)
  })

  it('throws on duplicate slash command across plugins', () => {
    const registry = createPluginRegistry()
    registry.register(samplePlugin())
    expect(() => {
      registry.register(
        samplePlugin({
          name: 'other',
          commands: [{ command: '/crawl-list', description: 'dup' }],
        }),
      )
    }).toThrow(SlashCommandConflictError)
  })

  it('returns manifest commands across all plugins', () => {
    const registry = createPluginRegistry()
    registry.register(samplePlugin())
    registry.register(
      samplePlugin({
        name: 'blog',
        commands: [{ command: '/blog-post', description: 'Publish a post' }],
      }),
    )
    const commands = registry.buildAppManifestCommands()
    expect(commands.map((c) => c.command)).toEqual([
      '/crawl-list',
      '/crawl-run',
      '/blog-post',
    ])
  })

  it('starts empty and accepts zero plugins', () => {
    const registry = createPluginRegistry()
    expect(registry.listPlugins()).toEqual([])
    expect(registry.buildAppManifestCommands()).toEqual([])
  })
})
