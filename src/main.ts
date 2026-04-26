import { serve } from '@hono/node-server'

import { createCloudflareAccessHttpClientFactory } from '@/cf-access/http-client'
import { loadConfig } from '@/config/config'
import { createLogger } from '@/logger/logger'
import type { Plugin } from '@/plugin/plugin'
import { createPluginRegistry } from '@/plugin/registry'
import { createInteractionRouter } from '@/router/router'
import { createScheduler } from '@/scheduler/scheduler'
import { createSignatureVerifier } from '@/security/signature-verifier'
import { createHttpServer } from '@/server/http-server'
import { createSlackWebClient } from '@/slack/web-client'

export interface BootstrapOptions {
  readonly plugins?: readonly Plugin[]
}

export const bootstrap = (options: BootstrapOptions = {}): void => {
  const config = loadConfig()
  const logger = createLogger({
    level: config.logLevel,
    base: { service: 'slack-bot' },
  })
  const verifier = createSignatureVerifier({
    signingSecret: config.slackSigningSecret,
  })
  const slackClient = createSlackWebClient({
    botToken: config.slackBotToken,
    maxRetries: config.maxWebApiRetries,
  })
  const registry = createPluginRegistry()
  for (const plugin of options.plugins ?? []) {
    registry.register(plugin)
    logger.info(
      {
        event: 'plugin_registered',
        plugin: plugin.name,
        commands: plugin.commands.map((c) => c.command),
      },
      'plugin registered',
    )
  }
  const scheduler = createScheduler({
    maxConcurrentTasks: config.maxConcurrentTasks,
    logger,
  })
  void scheduler
  const cfAccess = createCloudflareAccessHttpClientFactory({ config })
  void cfAccess
  const router = createInteractionRouter({
    registry,
    slackClient,
    logger,
  })
  const server = createHttpServer({ verifier, router, logger })
  server.health.setReady()

  serve({ fetch: server.app.fetch, port: config.port }, (info) => {
    logger.info(
      { event: 'server_listening', port: info.port },
      'slack-bot listening',
    )
  })
}

const entry = process.argv[1] ?? ''
if (entry.endsWith('main.js') || entry.endsWith('main.ts')) {
  bootstrap()
}
