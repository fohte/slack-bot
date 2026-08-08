import {
  optionalEnum,
  optionalInt,
  optionalString,
  parseEnv,
  requireString,
} from '@fohte/service-kit/env'
import { err, ok, type Result } from 'neverthrow'

import { ConfigLoadError } from '#types/errors'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

export interface ServiceTokenPair {
  readonly clientId: string
  readonly clientSecret: string
}

// OPENCODE_API_KEY is unprefixed: multiple services share this credential,
// so it isn't namespaced per-service like SLACK_BOT_CONVERSATION_AGENT_*.
export interface ConversationAgentConfig {
  readonly model: string
  readonly personaPrompt: string | undefined
  readonly opencodeApiKey: string
  readonly llmBaseUrl: string | undefined
}

// Shares ConversationAgentConfig.opencodeApiKey and the same OpenCode Go
// endpoint. The model can differ from the conversation agent's since image
// analysis benefits from a vision-accurate model, but when unset it falls
// back to the conversation agent's own model rather than being required.
export interface ImageAnalysisConfig {
  readonly model: string
}

export interface Config {
  readonly slackSigningSecret: string
  readonly slackBotToken: string
  readonly slackBotUserId: string
  readonly databaseUrl: string
  readonly port: number
  readonly maxConcurrentTasks: number
  readonly maxWebApiRetries: number
  readonly logLevel: LogLevel
  readonly conversationAgent: ConversationAgentConfig
  readonly imageAnalysis: ImageAnalysisConfig
  // Delegation targets for RemoteAgentRegistry. Empty means the
  // conversation agent runs with no delegation tools.
  readonly remoteAgentUrls: readonly string[]
  // External MCP servers whose tools are fetched at startup and injected
  // into the conversation agent alongside delegation tools. Empty means no
  // MCP tools are added.
  readonly mcpServerUrls: readonly string[]
  // Shared secret verified against the X-A2A-Notification-Token header on
  // POST /api/a2a/notifications, the endpoint remote agents push completed
  // or failed A2A tasks to.
  readonly a2aNotificationToken: string
  // Full URL of this service's own POST /api/a2a/notifications endpoint, as
  // reachable by remote agents (may be an internal cluster address). Sent to
  // remote agents as their push-notification callback target on every
  // delegation/resume. Omitted means delegated tasks rely solely on
  // tasks/get polling to surface progress and completion.
  readonly a2aNotificationUrl: string | undefined
  serviceTokenFor(pluginName: string): ServiceTokenPair | undefined
}

const DEFAULT_PORT = 8080
const DEFAULT_MAX_CONCURRENT_TASKS = 32
const DEFAULT_MAX_WEB_API_RETRIES = 3
const DEFAULT_LOG_LEVEL: LogLevel = 'info'

const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

export interface LoadConfigOptions {
  readonly env?: NodeJS.ProcessEnv | undefined
}

export const loadConfig = (options: LoadConfigOptions = {}): Config => {
  const env = options.env ?? process.env

  const parsed = parseEnv({
    slackSigningSecret: requireString(env, 'SLACK_SIGNING_SECRET'),
    slackBotToken: requireString(env, 'SLACK_BOT_TOKEN'),
    slackBotUserId: requireString(env, 'SLACK_BOT_USER_ID'),
    databaseUrl: requireString(env, 'DATABASE_URL'),
    port: optionalInt(env, 'PORT', DEFAULT_PORT, { min: 1 }),
    maxConcurrentTasks: optionalInt(
      env,
      'MAX_CONCURRENT_TASKS',
      DEFAULT_MAX_CONCURRENT_TASKS,
      { min: 1 },
    ),
    maxWebApiRetries: optionalInt(
      env,
      'MAX_WEB_API_RETRIES',
      DEFAULT_MAX_WEB_API_RETRIES,
      { min: 0 },
    ),
    logLevel: optionalEnum(env, 'LOG_LEVEL', LOG_LEVELS, DEFAULT_LOG_LEVEL),
    conversationAgentModel: requireString(
      env,
      'SLACK_BOT_CONVERSATION_AGENT_MODEL',
    ),
    conversationAgentPersonaPrompt: optionalString(
      env,
      'SLACK_BOT_CONVERSATION_AGENT_PERSONA_PROMPT',
    ),
    opencodeApiKey: requireString(env, 'OPENCODE_API_KEY'),
    llmBaseUrl: optionalUrl(env, 'SLACK_BOT_LLM_BASE_URL'),
    imageAnalysisModel: optionalString(env, 'SLACK_BOT_IMAGE_ANALYSIS_MODEL'),
    remoteAgentUrls: optionalUrlList(env, 'REMOTE_AGENT_URLS'),
    mcpServerUrls: optionalUrlList(env, 'MCP_SERVER_URLS'),
    a2aNotificationToken: requireString(env, 'A2A_NOTIFICATION_TOKEN'),
    a2aNotificationUrl: optionalUrl(env, 'A2A_NOTIFICATION_URL'),
  })

  if (parsed.isErr()) {
    // eslint-disable-next-line no-restricted-syntax -- boundary: startup fail-fast, config loading runs once before any Result-based flow exists to receive the error
    throw new ConfigLoadError(parsed.error.message)
  }
  const fields = parsed.value

  return {
    slackSigningSecret: fields.slackSigningSecret,
    slackBotToken: fields.slackBotToken,
    slackBotUserId: fields.slackBotUserId,
    databaseUrl: fields.databaseUrl,
    port: fields.port,
    maxConcurrentTasks: fields.maxConcurrentTasks,
    maxWebApiRetries: fields.maxWebApiRetries,
    logLevel: fields.logLevel,
    conversationAgent: {
      model: fields.conversationAgentModel,
      personaPrompt: fields.conversationAgentPersonaPrompt,
      opencodeApiKey: fields.opencodeApiKey,
      llmBaseUrl: fields.llmBaseUrl,
    },
    // Falls back to the conversation agent's own model so a deployment that
    // hasn't set this yet still starts up, just without the vision-accuracy
    // improvement this config exists for.
    imageAnalysis: {
      model: fields.imageAnalysisModel ?? fields.conversationAgentModel,
    },
    remoteAgentUrls: fields.remoteAgentUrls,
    mcpServerUrls: fields.mcpServerUrls,
    a2aNotificationToken: fields.a2aNotificationToken,
    a2aNotificationUrl: fields.a2aNotificationUrl,
    serviceTokenFor: (pluginName) => lookupServiceToken(env, pluginName),
  }
}

// service-kit's `/env` module has no URL parser, so this repo's own URL
// validation stays here.
const optionalUrl = (
  env: NodeJS.ProcessEnv,
  key: string,
): Result<string | undefined, string> => {
  const raw = env[key]
  if (raw === undefined || raw === '') return ok(undefined)
  if (!URL.canParse(raw)) {
    return err(`environment variable ${key} must be a valid URL (got: ${raw})`)
  }
  return ok(raw)
}

const optionalUrlList = (
  env: NodeJS.ProcessEnv,
  key: string,
): Result<readonly string[], string> => {
  const raw = env[key]
  if (raw === undefined || raw === '') return ok([])
  const urls: string[] = []
  for (const entry of raw.split(',')) {
    const url = entry.trim()
    if (url === '') {
      return err(`environment variable ${key} contains an empty URL entry`)
    }
    if (!URL.canParse(url)) {
      return err(
        `environment variable ${key} contains an invalid URL entry '${url}'`,
      )
    }
    urls.push(url)
  }
  return ok(urls)
}

const lookupServiceToken = (
  env: NodeJS.ProcessEnv,
  pluginName: string,
): ServiceTokenPair | undefined => {
  if (!PLUGIN_NAME_PATTERN.test(pluginName)) return undefined
  const upper = pluginName.toUpperCase().replace(/-/g, '_')
  const clientId = env[`CF_ACCESS_${upper}_CLIENT_ID`]
  const clientSecret = env[`CF_ACCESS_${upper}_CLIENT_SECRET`]
  if (
    clientId === undefined ||
    clientId === '' ||
    clientSecret === undefined ||
    clientSecret === ''
  ) {
    return undefined
  }
  return { clientId, clientSecret }
}
