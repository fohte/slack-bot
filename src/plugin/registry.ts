import type { Plugin, SlackAppManifestCommand } from '@/plugin/plugin'
import {
  PluginInvalidNameError,
  PluginNameConflictError,
  SlashCommandConflictError,
} from '@/types/errors'

const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

export interface PluginRegistry {
  register(plugin: Plugin): void
  lookupCommand(commandName: string): Plugin | undefined
  lookupByActionOrCallbackId(id: string): Plugin | undefined
  buildAppManifestCommands(): SlackAppManifestCommand[]
  listPlugins(): readonly Plugin[]
}

export const createPluginRegistry = (): PluginRegistry => {
  const plugins = new Map<string, Plugin>()
  const commandIndex = new Map<string, Plugin>()

  return {
    register(plugin) {
      if (!PLUGIN_NAME_PATTERN.test(plugin.name)) {
        throw new PluginInvalidNameError(plugin.name)
      }
      if (plugins.has(plugin.name)) {
        throw new PluginNameConflictError(plugin.name)
      }
      for (const command of plugin.commands) {
        const existing = commandIndex.get(command.command)
        if (existing !== undefined) {
          throw new SlashCommandConflictError(
            command.command,
            existing.name,
            plugin.name,
          )
        }
      }
      plugins.set(plugin.name, plugin)
      for (const command of plugin.commands) {
        commandIndex.set(command.command, plugin)
      }
    },
    lookupCommand(commandName) {
      return commandIndex.get(commandName)
    },
    lookupByActionOrCallbackId(id) {
      const prefix = id.split(':', 1)[0]
      if (prefix === undefined || prefix.length === 0) return undefined
      return plugins.get(prefix)
    },
    buildAppManifestCommands() {
      const out: SlackAppManifestCommand[] = []
      for (const plugin of plugins.values()) {
        for (const command of plugin.commands) {
          out.push({ ...command })
        }
      }
      return out
    },
    listPlugins() {
      return Array.from(plugins.values())
    },
  }
}
