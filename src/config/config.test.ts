import { describe, expect, it } from 'vitest'

import { loadConfig } from '@/config/config'
import { ConfigLoadError } from '@/types/errors'

const baseEnv = {
  SLACK_SIGNING_SECRET: 'sig',
  SLACK_BOT_TOKEN: 'xoxb-test',
  DATABASE_URL: 'postgres://localhost/test',
} satisfies NodeJS.ProcessEnv

describe('loadConfig', () => {
  it('loads required env and applies defaults', () => {
    const config = loadConfig({ env: { ...baseEnv } })
    expect(config.slackSigningSecret).toBe('sig')
    expect(config.slackBotToken).toBe('xoxb-test')
    expect(config.databaseUrl).toBe('postgres://localhost/test')
    expect(config.port).toBe(8080)
    expect(config.maxConcurrentTasks).toBe(32)
    expect(config.maxWebApiRetries).toBe(3)
    expect(config.logLevel).toBe('info')
  })

  it('throws ConfigLoadError when SLACK_SIGNING_SECRET is missing', () => {
    const env = { ...baseEnv, SLACK_SIGNING_SECRET: undefined }
    expect(() => loadConfig({ env })).toThrow(ConfigLoadError)
  })

  it('throws ConfigLoadError when SLACK_BOT_TOKEN is missing', () => {
    const env = { ...baseEnv, SLACK_BOT_TOKEN: undefined }
    expect(() => loadConfig({ env })).toThrow(ConfigLoadError)
  })

  it('throws ConfigLoadError when DATABASE_URL is missing', () => {
    const env = { ...baseEnv, DATABASE_URL: undefined }
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
