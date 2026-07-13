import { describe, expect, it } from 'vitest'

import { loadConfig } from '@/config/config'
import { ConfigLoadError } from '@/types/errors'

const baseEnv = {
  SLACK_SIGNING_SECRET: 'sig',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_BOT_USER_ID: 'U_BOT',
  DATABASE_URL: 'postgres://localhost/test',
  SLACK_BOT_CONVERSATION_AGENT_MODEL: 'opencode-go/gpt-5',
  OPENCODE_API_KEY: 'sk-test',
  A2A_NOTIFICATION_TOKEN: 'notif-token',
} satisfies NodeJS.ProcessEnv

describe('loadConfig', () => {
  it('loads required env and applies defaults', () => {
    const config = loadConfig({ env: { ...baseEnv } })
    expect(config.slackSigningSecret).toBe('sig')
    expect(config.slackBotToken).toBe('xoxb-test')
    expect(config.slackBotUserId).toBe('U_BOT')
    expect(config.databaseUrl).toBe('postgres://localhost/test')
    expect(config.port).toBe(8080)
    expect(config.maxConcurrentTasks).toBe(32)
    expect(config.maxWebApiRetries).toBe(3)
    expect(config.logLevel).toBe('info')
    expect(config.conversationAgent).toEqual({
      model: 'opencode-go/gpt-5',
      personaPrompt: undefined,
      opencodeApiKey: 'sk-test',
    })
    expect(config.remoteAgentUrls).toEqual([])
    expect(config.a2aNotificationToken).toBe('notif-token')
  })

  it('reads optional conversation-agent env overrides', () => {
    const config = loadConfig({
      env: {
        ...baseEnv,
        SLACK_BOT_CONVERSATION_AGENT_MODEL: 'opencode-go/claude-sonnet-4-6',
        SLACK_BOT_CONVERSATION_AGENT_PERSONA_PROMPT: 'Be concise.',
        OPENCODE_API_KEY: 'sk-test',
      },
    })
    expect(config.conversationAgent).toEqual({
      model: 'opencode-go/claude-sonnet-4-6',
      personaPrompt: 'Be concise.',
      opencodeApiKey: 'sk-test',
    })
  })

  it('parses REMOTE_AGENT_URLS as a comma-separated, trimmed URL list', () => {
    const config = loadConfig({
      env: {
        ...baseEnv,
        REMOTE_AGENT_URLS:
          'https://meshi.example.com, https://t-rader.example.com',
      },
    })
    expect(config.remoteAgentUrls).toEqual([
      'https://meshi.example.com',
      'https://t-rader.example.com',
    ])
  })

  it('rejects an invalid URL entry in REMOTE_AGENT_URLS', () => {
    expect(() =>
      loadConfig({ env: { ...baseEnv, REMOTE_AGENT_URLS: 'not-a-url' } }),
    ).toThrow(ConfigLoadError)
  })

  it('rejects an empty entry in REMOTE_AGENT_URLS', () => {
    expect(() =>
      loadConfig({
        env: {
          ...baseEnv,
          REMOTE_AGENT_URLS: 'https://meshi.example.com,,',
        },
      }),
    ).toThrow(ConfigLoadError)
  })

  it('throws ConfigLoadError when SLACK_SIGNING_SECRET is missing', () => {
    const env = { ...baseEnv, SLACK_SIGNING_SECRET: undefined }
    expect(() => loadConfig({ env })).toThrow(ConfigLoadError)
  })

  it('throws ConfigLoadError when SLACK_BOT_TOKEN is missing', () => {
    const env = { ...baseEnv, SLACK_BOT_TOKEN: undefined }
    expect(() => loadConfig({ env })).toThrow(ConfigLoadError)
  })

  it('throws ConfigLoadError when SLACK_BOT_USER_ID is missing', () => {
    const env = { ...baseEnv, SLACK_BOT_USER_ID: undefined }
    expect(() => loadConfig({ env })).toThrow(ConfigLoadError)
  })

  it('throws ConfigLoadError when DATABASE_URL is missing', () => {
    const env = { ...baseEnv, DATABASE_URL: undefined }
    expect(() => loadConfig({ env })).toThrow(ConfigLoadError)
  })

  it('throws ConfigLoadError when SLACK_BOT_CONVERSATION_AGENT_MODEL is missing', () => {
    const env = { ...baseEnv, SLACK_BOT_CONVERSATION_AGENT_MODEL: undefined }
    expect(() => loadConfig({ env })).toThrow(ConfigLoadError)
  })

  it('throws ConfigLoadError when OPENCODE_API_KEY is missing', () => {
    const env = { ...baseEnv, OPENCODE_API_KEY: undefined }
    expect(() => loadConfig({ env })).toThrow(ConfigLoadError)
  })

  it('throws ConfigLoadError when A2A_NOTIFICATION_TOKEN is missing', () => {
    const env = { ...baseEnv, A2A_NOTIFICATION_TOKEN: undefined }
    expect(() => loadConfig({ env })).toThrow(ConfigLoadError)
  })

  it('parses overrides for numeric env vars', () => {
    const config = loadConfig({
      env: {
        ...baseEnv,
        PORT: '3001',
        MAX_CONCURRENT_TASKS: '8',
        MAX_WEB_API_RETRIES: '0',
        LOG_LEVEL: 'debug',
      },
    })
    expect(config.port).toBe(3001)
    expect(config.maxConcurrentTasks).toBe(8)
    expect(config.maxWebApiRetries).toBe(0)
    expect(config.logLevel).toBe('debug')
  })

  it('rejects invalid PORT', () => {
    expect(() => loadConfig({ env: { ...baseEnv, PORT: 'abc' } })).toThrow(
      ConfigLoadError,
    )
  })

  it('rejects invalid LOG_LEVEL', () => {
    expect(() =>
      loadConfig({ env: { ...baseEnv, LOG_LEVEL: 'verbose' } }),
    ).toThrow(ConfigLoadError)
  })

  it('returns plugin-specific service token via env naming convention', () => {
    const config = loadConfig({
      env: {
        ...baseEnv,
        CF_ACCESS_CRAWL_CLIENT_ID: 'id',
        CF_ACCESS_CRAWL_CLIENT_SECRET: 'secret',
      },
    })
    expect(config.serviceTokenFor('crawl')).toEqual({
      clientId: 'id',
      clientSecret: 'secret',
    })
  })

  it('uppercases and replaces hyphens when looking up service tokens', () => {
    const config = loadConfig({
      env: {
        ...baseEnv,
        CF_ACCESS_BLOG_PUBLISH_CLIENT_ID: 'id',
        CF_ACCESS_BLOG_PUBLISH_CLIENT_SECRET: 'secret',
      },
    })
    expect(config.serviceTokenFor('blog-publish')).toEqual({
      clientId: 'id',
      clientSecret: 'secret',
    })
  })

  it('returns undefined when service token pair is incomplete', () => {
    const config = loadConfig({
      env: { ...baseEnv, CF_ACCESS_CRAWL_CLIENT_ID: 'id' },
    })
    expect(config.serviceTokenFor('crawl')).toBeUndefined()
  })
})
