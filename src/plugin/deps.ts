import type { CloudflareAccessHttpClientFactory } from '@/cf-access/http-client'
import type { Config } from '@/config/config'
import type { Logger } from '@/logger/logger'
import type { Plugin } from '@/plugin/plugin'
import type { EventLogStore, ThreadSessionStore } from '@/plugins/llm-agent'
import type { InMemoryScheduler } from '@/scheduler/scheduler'
import type { SlackWebClient } from '@/slack/web-client'

export interface PluginDeps {
  readonly config: Config
  readonly logger: Logger
  readonly slackClient: SlackWebClient
  readonly scheduler: InMemoryScheduler
  readonly cfAccess: CloudflareAccessHttpClientFactory
  readonly eventLogStore: EventLogStore
  readonly threadSessionStore: ThreadSessionStore
}

export type PluginFactory = (deps: PluginDeps) => Plugin

export type PluginInput = Plugin | PluginFactory

export const resolvePlugin = (input: PluginInput, deps: PluginDeps): Plugin => {
  if (typeof input === 'function') {
    return input(deps)
  }
  return input
}
