import { ConfigLoadError } from '@/types/errors'

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

  const slackSigningSecret = requireEnv(env, 'SLACK_SIGNING_SECRET')
  const slackBotToken = requireEnv(env, 'SLACK_BOT_TOKEN')
  const slackBotUserId = requireEnv(env, 'SLACK_BOT_USER_ID')
  const databaseUrl = requireEnv(env, 'DATABASE_URL')

  const port = parsePositiveInt(env, 'PORT', DEFAULT_PORT)
  const maxConcurrentTasks = parsePositiveInt(
    env,
    'MAX_CONCURRENT_TASKS',
    DEFAULT_MAX_CONCURRENT_TASKS,
  )
  const maxWebApiRetries = parseNonNegativeInt(
    env,
    'MAX_WEB_API_RETRIES',
    DEFAULT_MAX_WEB_API_RETRIES,
  )
  const logLevel = parseLogLevel(env, 'LOG_LEVEL', DEFAULT_LOG_LEVEL)

  const conversationAgent: ConversationAgentConfig = {
    model: requireEnv(env, 'SLACK_BOT_CONVERSATION_AGENT_MODEL'),
    personaPrompt: optionalString(
      env,
      'SLACK_BOT_CONVERSATION_AGENT_PERSONA_PROMPT',
    ),
    opencodeApiKey: requireEnv(env, 'OPENCODE_API_KEY'),
  }

  const remoteAgentUrls = optionalUrlList(env, 'REMOTE_AGENT_URLS')
  const mcpServerUrls = optionalUrlList(env, 'MCP_SERVER_URLS')
  const a2aNotificationToken = requireEnv(env, 'A2A_NOTIFICATION_TOKEN')

  return {
    slackSigningSecret,
    slackBotToken,
    slackBotUserId,
    databaseUrl,
    port,
    maxConcurrentTasks,
    maxWebApiRetries,
    logLevel,
    conversationAgent,
    remoteAgentUrls,
    mcpServerUrls,
    a2aNotificationToken,
    serviceTokenFor: (pluginName) => lookupServiceToken(env, pluginName),
  }
}

const optionalString = (
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined => {
  const raw = env[key]
  if (raw === undefined || raw === '') return undefined
  return raw
}

const optionalUrlList = (
  env: NodeJS.ProcessEnv,
  key: string,
): readonly string[] => {
  const raw = env[key]
  if (raw === undefined || raw === '') return []
  return raw.split(',').map((entry) => {
    const url = entry.trim()
    if (url === '') {
      throw new ConfigLoadError(
        `Environment variable '${key}' contains an empty URL entry`,
      )
    }
    try {
      new URL(url)
    } catch {
      throw new ConfigLoadError(
        `Environment variable '${key}' contains an invalid URL entry '${url}'`,
      )
    }
    return url
  })
}

const requireEnv = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key]
  if (value === undefined || value === '') {
    throw new ConfigLoadError(
      `Required environment variable '${key}' is not set`,
    )
  }
  return value
}

const parsePositiveInt = (
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number => {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigLoadError(
      `Environment variable '${key}' must be a positive integer (got '${raw}')`,
    )
  }
  return parsed
}

const parseNonNegativeInt = (
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number => {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ConfigLoadError(
      `Environment variable '${key}' must be a non-negative integer (got '${raw}')`,
    )
  }
  return parsed
}

const parseLogLevel = (
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: LogLevel,
): LogLevel => {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  if (!isLogLevel(raw)) {
    throw new ConfigLoadError(
      `Environment variable '${key}' must be one of ${LOG_LEVELS.join(', ')} (got '${raw}')`,
    )
  }
  return raw
}

const isLogLevel = (value: string): value is LogLevel =>
  (LOG_LEVELS as readonly string[]).includes(value)

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
