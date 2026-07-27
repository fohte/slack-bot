import '#bootstrap'

import { serve } from '@hono/node-server'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { createCloudflareAccessHttpClientFactory } from '#cf-access/http-client'
import { loadConfig } from '#config/config'
import { createLogger } from '#logger/logger'
import type { PluginDeps, PluginInput } from '#plugin/deps'
import { resolvePlugin } from '#plugin/deps'
import { createPluginRegistry } from '#plugin/registry'
import { createBlogPlugin, loadBlogPluginConfig } from '#plugins/blog/index'
import type {
  PersonaParaphraser,
  RemoteAgentRegistry,
} from '#plugins/llm-agent/index'
import {
  createA2aNotificationHandler,
  createA2aTaskTracker,
  createConversationAgent,
  createConversationCheckpointer,
  createDelegationTools,
  createEventLogStore,
  createLlmAgentPlugin,
  createMcpTools,
  createOpenCodeGoChatModel,
  createPersonaParaphraser,
  createRemoteAgentRegistry,
  createResponseFinalizer,
  createTaskDispatcher,
  startEventLogRetention,
  startTaskReconciler,
} from '#plugins/llm-agent/index'
import { createInteractionRouter } from '#router/router'
import { createScheduler } from '#scheduler/scheduler'
import { createSignatureVerifier } from '#security/signature-verifier'
import { createHttpServer } from '#server/http-server'
import { createInFlightTasks } from '#server/in-flight-tasks'
import { createShutdownHandler } from '#server/shutdown'
import { createSlackWebClient } from '#slack/web-client'

export interface BootstrapOptions {
  readonly plugins?: readonly PluginInput[]
  // Reused (rather than constructed fresh here) so the push notification
  // endpoint's tasks/get calls share the same Agent Card cache the
  // conversation agent's delegation tools already warmed at startup.
  readonly remoteAgentRegistry: RemoteAgentRegistry
  // Reused (rather than constructed fresh here) so responseFinalizer's
  // persona paraphrase shares the same stateless model instance the
  // conversation agent uses for live turns.
  readonly personaParaphraser: PersonaParaphraser
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
  const a2aTaskTracker = createA2aTaskTracker(db)
  startEventLogRetention({ eventLogStore, logger })

  const deps: PluginDeps = {
    config,
    logger,
    slackClient,
    scheduler,
    cfAccess,
    eventLogStore,
    a2aTaskTracker,
    inFlightTasks,
  }

  const registry = createPluginRegistry()
  for (const input of options.plugins ?? []) {
    const plugin = resolvePlugin(input, deps)
    const registerResult = registry.register(plugin)
    // eslint-disable-next-line no-restricted-syntax -- boundary: process startup fail-fast, bootstrap() runs once before serve() and has no caller to propagate a Result to
    if (registerResult.isErr()) throw registerResult.error
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
    personaParaphraser: options.personaParaphraser,
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
if (entry.endsWith('index.js') || entry.endsWith('index.ts')) {
  // Loaded again (redundantly but harmlessly) inside bootstrap() below;
  // needed here to resolve delegation and MCP tools before the plugin
  // factory runs, since createConversationAgent bakes its tool list in at
  // construction time and PluginFactory itself is synchronous.
  const config = loadConfig()
  const logger = createLogger({
    level: config.logLevel,
    base: { service: 'slack-bot' },
  })
  const remoteAgentRegistry = createRemoteAgentRegistry({
    agentUrls: config.remoteAgentUrls,
  })
  // Resolved once here at startup (with its own TTL cache), then reused —
  // via the same registry instance's warm cache — by the dispatcher's own
  // task-resume lookups. MCP tools have no such reuse elsewhere, so they're
  // fetched once and passed straight into the tools list below.
  const [remoteAgentHandles, mcpTools] = await Promise.all([
    remoteAgentRegistry.listAgents(),
    // ResultAsync never rejects on its own, so Promise.all would otherwise
    // wait for listAgents() too before this startup invariant violation
    // surfaces — match() converts the Err case back into a rejection to
    // keep the original fail-fast behavior.
    createMcpTools({ serverUrls: config.mcpServerUrls, logger }).match(
      (tools) => tools,
      (error) => {
        // eslint-disable-next-line no-restricted-syntax -- boundary: process startup fail-fast, converts the Err back into a rejection so Promise.all fails fast instead of waiting for listAgents() too
        throw error
      },
    ),
  ])
  const model = createOpenCodeGoChatModel({
    apiKey: config.conversationAgent.opencodeApiKey,
    model: config.conversationAgent.model,
  })
  const personaParaphraser = createPersonaParaphraser({
    model,
    personaPrompt: config.conversationAgent.personaPrompt,
    logger,
  })
  const checkpointer = createConversationCheckpointer(config.databaseUrl)

  bootstrap({
    remoteAgentRegistry,
    personaParaphraser,
    // Keep MANIFEST_PLUGINS in src/scripts/print-slash-commands.ts in sync
    // with the plugins listed here when adding or removing one.
    plugins: [
      ({ logger, scheduler }) =>
        createBlogPlugin({
          config: loadBlogPluginConfig(),
          logger,
          scheduler,
        }),
      ({
        logger,
        slackClient,
        eventLogStore,
        a2aTaskTracker,
        inFlightTasks,
      }) => {
        const delegationToolsResult = createDelegationTools(
          remoteAgentHandles,
          { a2aTaskTracker, logger },
        )
        // eslint-disable-next-line no-restricted-syntax -- boundary: process startup fail-fast, the plugin factory runs once during bootstrap() with no caller to propagate a Result to
        if (delegationToolsResult.isErr()) throw delegationToolsResult.error
        const tools = [...delegationToolsResult.value, ...mcpTools]
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
