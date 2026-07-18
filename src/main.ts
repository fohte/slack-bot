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
import type { RemoteAgentRegistry } from '@/plugins/llm-agent'
import {
  createA2aNotificationHandler,
  createA2aTaskTracker,
  createConversationAgent,
  createConversationCheckpointer,
  createDelegationTools,
  createEventLogStore,
  createLlmAgentPlugin,
  createOpenCodeGoChatModel,
  createRemoteAgentRegistry,
  createResponseFinalizer,
  createTaskDispatcher,
  createThreadSessionStore,
  startEventLogRetention,
  startTaskReconciler,
} from '@/plugins/llm-agent'
import { createInteractionRouter } from '@/router/router'
import { createScheduler } from '@/scheduler/scheduler'
import { createSignatureVerifier } from '@/security/signature-verifier'
import { createHttpServer } from '@/server/http-server'
import { createInFlightTasks } from '@/server/in-flight-tasks'
import { createShutdownHandler } from '@/server/shutdown'
import { createSlackWebClient } from '@/slack/web-client'

export interface BootstrapOptions {
  readonly plugins?: readonly PluginInput[]
  // Reused (rather than constructed fresh here) so the push notification
  // endpoint's tasks/get calls share the same Agent Card cache the
  // conversation agent's delegation tools already warmed at startup.
  readonly remoteAgentRegistry: RemoteAgentRegistry
}

export const bootstrap = (options: BootstrapOptions): void => {
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
  const inFlightTasks = createInFlightTasks()

  const postgresClient = postgres(config.databaseUrl)
  const db = drizzle(postgresClient)
  const eventLogStore = createEventLogStore(db)
  const threadSessionStore = createThreadSessionStore(db)
  const a2aTaskTracker = createA2aTaskTracker(db)
  startEventLogRetention({ eventLogStore, logger })

  const deps: PluginDeps = {
    config,
    logger,
    slackClient,
    scheduler,
    cfAccess,
    eventLogStore,
    threadSessionStore,
    a2aTaskTracker,
    inFlightTasks,
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
  const responseFinalizer = createResponseFinalizer({
    a2aTaskTracker,
    remoteAgentRegistry: options.remoteAgentRegistry,
    eventLogStore,
    slackClient,
    logger,
  })
  const a2aNotificationHandler = createA2aNotificationHandler({
    token: config.a2aNotificationToken,
    responseFinalizer,
    logger,
  })
  const taskReconciler = startTaskReconciler({
    a2aTaskTracker,
    remoteAgentRegistry: options.remoteAgentRegistry,
    responseFinalizer,
    eventLogStore,
    slackClient,
    inFlightTasks,
    logger,
  })
  void taskReconciler.runOnce()
  const server = createHttpServer({
    verifier,
    router,
    logger,
    inFlightTasks,
    routes: [
      { path: '/api/a2a/notifications', handler: a2aNotificationHandler },
    ],
  })
  server.health.setReady()

  const httpServer = serve(
    { fetch: server.app.fetch, port: config.port },
    (info) => {
      logger.info(
        { event: 'server_listening', port: info.port },
        'slack-bot listening',
      )
    },
  )

  const shutdown = createShutdownHandler({
    server: httpServer,
    inFlightTasks,
    logger,
  })
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
}

const entry = process.argv[1] ?? ''
if (entry.endsWith('main.js') || entry.endsWith('main.ts')) {
  // Loaded again (redundantly but harmlessly) inside bootstrap() below;
  // needed here to resolve delegation tools before the plugin factory runs,
  // since createConversationAgent bakes its tool list in at construction
  // time and PluginFactory itself is synchronous.
  const config = loadConfig()
  const remoteAgentRegistry = createRemoteAgentRegistry({
    agentUrls: config.remoteAgentUrls,
  })
  // Resolved once here at startup (with its own TTL cache), then reused —
  // via the same registry instance's warm cache — by the dispatcher's own
  // task-resume lookups.
  const remoteAgentHandles = await remoteAgentRegistry.listAgents()
  const model = createOpenCodeGoChatModel({
    apiKey: config.conversationAgent.opencodeApiKey,
    model: config.conversationAgent.model,
  })
  const checkpointer = createConversationCheckpointer(config.databaseUrl)

  bootstrap({
    remoteAgentRegistry,
    plugins: [
      ({
        logger,
        slackClient,
        eventLogStore,
        a2aTaskTracker,
        inFlightTasks,
      }) => {
        const tools = createDelegationTools(remoteAgentHandles, {
          a2aTaskTracker,
          logger,
        })
        const conversationAgent = createConversationAgent({
          model,
          checkpointer,
          personaPrompt: config.conversationAgent.personaPrompt,
          tools,
          logger,
        })
        const onAccepted = createTaskDispatcher({
          conversationAgent,
          remoteAgentRegistry,
          a2aTaskTracker,
          eventLogStore,
          slackClient,
          logger,
          inFlightTasks,
        })
        return createLlmAgentPlugin({
          logger,
          eventLogStore,
          checkpointer,
          a2aTaskTracker,
          botUserId: config.slackBotUserId,
          onAccepted,
        })
      },
    ],
  })
}
