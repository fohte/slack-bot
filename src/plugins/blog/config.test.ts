import { describe, expect, it } from 'vitest'

import { loadBlogPluginConfig } from '@/plugins/blog/config'
import { ConfigLoadError } from '@/types/errors'

describe('loadBlogPluginConfig', () => {
  it('loads required env vars and parses allowed user IDs', () => {
    const config = loadBlogPluginConfig({
      env: {
        BLOG_SERVICE_URL: 'https://blog.example/',
        BLOG_SERVICE_TOKEN: 'token-xyz',
        BLOG_ALLOWED_SLACK_USER_IDS: 'U1, U2 ,U3',
      },
    })
    expect(config.serviceUrl).toBe('https://blog.example/')
    expect(config.serviceToken).toBe('token-xyz')
    expect(config.allowedSlackUserIds).toEqual(['U1', 'U2', 'U3'])
  })

  it('defaults allowedSlackUserIds to empty when unset', () => {
    const config = loadBlogPluginConfig({
      env: {
        BLOG_SERVICE_URL: 'https://x',
        BLOG_SERVICE_TOKEN: 't',
      },
    })
    expect(config.allowedSlackUserIds).toEqual([])
  })

  it('throws when BLOG_SERVICE_URL is missing', () => {
    expect(() =>
      loadBlogPluginConfig({ env: { BLOG_SERVICE_TOKEN: 't' } }),
    ).toThrow(ConfigLoadError)
  })

  it('throws when BLOG_SERVICE_TOKEN is missing', () => {
    expect(() =>
      loadBlogPluginConfig({ env: { BLOG_SERVICE_URL: 'https://x' } }),
    ).toThrow(ConfigLoadError)
  })
})
