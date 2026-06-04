import { ConfigLoadError } from '@/types/errors'

export interface BlogPluginConfig {
  readonly serviceUrl: string
  readonly serviceToken: string
  readonly allowedSlackUserIds: readonly string[]
}

export interface LoadBlogPluginConfigOptions {
  readonly env?: NodeJS.ProcessEnv | undefined
}

export const loadBlogPluginConfig = (
  options: LoadBlogPluginConfigOptions = {},
): BlogPluginConfig => {
  const env = options.env ?? process.env
  const serviceUrl = requireEnv(env, 'BLOG_SERVICE_URL')
  const serviceToken = requireEnv(env, 'BLOG_SERVICE_TOKEN')
  const allowedSlackUserIds = parseUserIds(env['BLOG_ALLOWED_SLACK_USER_IDS'])
  return { serviceUrl, serviceToken, allowedSlackUserIds }
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

const parseUserIds = (raw: string | undefined): readonly string[] => {
  if (raw === undefined || raw === '') return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}
