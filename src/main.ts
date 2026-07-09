import '@/bootstrap'

import { serve } from '@hono/node-server'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { createCloudflareAccessHttpClientFactory } from '@/cf-access/http-client'
import { loadConfig } from '@/config/config'
import { createLogger } from '@/logger/logger'
import type { PluginDeps, PluginInput } from '@/plugin/deps'
import { resolvePlugin } from '@/plugin/deps'
import { createPluginRegistry } from '@/plugin/registry'
import {
  createEventLogStore,
  createKubernetesConfigMapClient,
  createKubernetesTaskCrClient,
  createLlmAgentPlugin,
  createOpencodeClient,
  createTaskDispatcher,
  createThreadSessionStore,
  startEventLogRetention,
  startResponseReconciler,
} from '@/plugins/llm-agent'
import { createInteractionRouter } from '@/router/router'
import { createScheduler } from '@/scheduler/scheduler'
import { createSignatureVerifier } from '@/security/signature-verifier'
import { createHttpServer } from '@/server/http-server'
import { createSlackWebClient } from '@/slack/web-client'

export interface BootstrapOptions {
  readonly plugins?: readonly PluginInput[]
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
  const scheduler = createScheduler({
    maxConcurrentTasks: config.maxConcurrentTasks,
    logger,
  })
  const cfAccess = createCloudflareAccessHttpClientFactory({ config })

  const postgresClient = postgres(config.databaseUrl)
  const db = drizzle(postgresClient)
  const eventLogStore = createEventLogStore(db)
  const threadSessionStore = createThreadSessionStore(db)
  startEventLogRetention({ eventLogStore, logger })

  const deps: PluginDeps = {
    config,
    logger,
    slackClient,
    scheduler,
    cfAccess,
    eventLogStore,
    threadSessionStore,
  }

  const registry = createPluginRegistry()
  for (const input of options.plugins ?? []) {
    const plugin = resolvePlugin(input, deps)
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
  bootstrap({
    plugins: [
      ({ config, logger, slackClient, eventLogStore, threadSessionStore }) => {
        const taskCrClient = createKubernetesTaskCrClient()
        const configMapClient = createKubernetesConfigMapClient()
        const opencodeClient = createOpencodeClient({
          baseUrl: config.llmAgent.opencodeBaseUrl,
        })
        const processMentionDeps = {
          taskCrClient,
          configMapClient,
          opencodeClient,
          threadSessionStore,
          eventLogStore,
          slackClient,
          logger,
          namespace: config.llmAgent.taskCrNamespace,
          agentName: config.llmAgent.taskCrAgentName,
        }
        const onAccepted = createTaskDispatcher(processMentionDeps)
        // Run once immediately in addition to the interval: on Pod restart
        // this is the earliest chance to recover a response the previous
        // Pod's fire-and-forget processMention never got to deliver.
        const reconciler = startResponseReconciler(processMentionDeps)
        void reconciler.runOnce()
        return createLlmAgentPlugin({
          logger,
          eventLogStore,
          threadSessionStore,
          botUserId: config.slackBotUserId,
          onAccepted,
        })
      },
    ],
  })
}
