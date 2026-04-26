import { describe, expect, it, vi } from 'vitest'

import { createCloudflareAccessHttpClientFactory } from '@/cf-access/http-client'
import { loadConfig } from '@/config/config'
import { CfAccessAuthError } from '@/types/errors'

const baseEnv = {
  SLACK_SIGNING_SECRET: 'sig',
  SLACK_BOT_TOKEN: 'xoxb',
}

describe('CloudflareAccessHttpClient', () => {
  it('attaches service token headers when env is set', async () => {
    const config = loadConfig({
      env: {
        ...baseEnv,
        CF_ACCESS_CRAWL_CLIENT_ID: 'id',
        CF_ACCESS_CRAWL_CLIENT_SECRET: 'secret',
      },
    })
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('ok', { status: 200 }),
    )
    const factory = createCloudflareAccessHttpClientFactory({
      config,
      fetchImpl,
    })
    const client = factory.forPlugin('crawl')
    await client.request('https://api.example.com/x', { method: 'GET' })
    const call = fetchImpl.mock.calls[0]
    expect(call).toBeDefined()
    const init = call?.[1] as RequestInit
    const headers = init.headers as Headers
    expect(headers.get('CF-Access-Client-Id')).toBe('id')
    expect(headers.get('CF-Access-Client-Secret')).toBe('secret')
  })

  it('throws CfAccessAuthError lazily when token is missing', async () => {
    const config = loadConfig({ env: { ...baseEnv } })
    const fetchImpl = vi.fn()
    const factory = createCloudflareAccessHttpClientFactory({
      config,
      fetchImpl: fetchImpl,
    })
    const client = factory.forPlugin('crawl')
    await expect(client.request('https://x')).rejects.toBeInstanceOf(
      CfAccessAuthError,
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
