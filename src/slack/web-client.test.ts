import type { WebClient } from '@slack/web-api'
import { describe, expect, it, vi } from 'vitest'

import { createSlackWebClient } from '@/slack/web-client'
import { SlackApiError } from '@/types/errors'

interface MockWebClient {
  chat: {
    postMessage: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
  }
  views: {
    open: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    push: ReturnType<typeof vi.fn>
  }
  assistant: {
    threads: {
      setStatus: ReturnType<typeof vi.fn>
    }
  }
}

const buildMockClient = (): MockWebClient => ({
  chat: {
    postMessage: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  views: {
    open: vi.fn(),
    update: vi.fn(),
    push: vi.fn(),
  },
  assistant: {
    threads: {
      setStatus: vi.fn(),
    },
  },
})

const asWebClient = (m: MockWebClient): WebClient => m as unknown as WebClient

describe('SlackWebClient', () => {
  it('forwards postMessage results from underlying client', async () => {
    const mock = buildMockClient()
    mock.chat.postMessage.mockResolvedValue({
      ok: true,
      channel: 'C1',
      ts: '1.0',
    })
    const client = createSlackWebClient({
      botToken: 'xoxb',
      maxRetries: 0,
      client: asWebClient(mock),
    })
    const res = await client.postMessage({ channel: 'C1', text: 'hi' })
    expect(res.channel).toBe('C1')
    expect(mock.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C1',
      text: 'hi',
    })
  })

  it('rethrows underlying errors as SlackApiError', async () => {
    const mock = buildMockClient()
    const slackErr = new Error('platform error') as Error & {
      data: { error: string }
    }
    slackErr.data = { error: 'channel_not_found' }
    mock.chat.postMessage.mockRejectedValue(slackErr)
    const client = createSlackWebClient({
      botToken: 'xoxb',
      maxRetries: 0,
      client: asWebClient(mock),
    })
    await expect(
      client.postMessage({ channel: 'C1', text: 'hi' }),
    ).rejects.toMatchObject({
      name: 'SlackApiError',
      slackError: 'channel_not_found',
    })
  })

  it('posts to response_url with JSON body and no Authorization header', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ ok: true, channel: 'C9', ts: '12.34' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const mock = buildMockClient()
    const client = createSlackWebClient({
      botToken: 'xoxb',
      maxRetries: 0,
      client: asWebClient(mock),
      fetchImpl,
    })
    const result = await client.postToResponseUrl(
      'https://hooks.slack.com/actions/abc',
      { text: 'hi', replace_original: true },
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const call = fetchImpl.mock.calls[0]
    expect(call).toBeDefined()
    const init = call?.[1] as RequestInit
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(headers['authorization']).toBeUndefined()
    expect(result.channelId).toBe('C9')
    expect(result.messageTs).toBe('12.34')
  })

  it('throws SlackApiError when response_url returns ok:false', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ ok: false, error: 'expired_url' }), {
          status: 200,
        }),
    )
    const mock = buildMockClient()
    const client = createSlackWebClient({
      botToken: 'xoxb',
      maxRetries: 0,
      client: asWebClient(mock),
      fetchImpl,
    })
    await expect(
      client.postToResponseUrl('https://hooks.slack.com/actions/abc', {
        text: 'hi',
      }),
    ).rejects.toBeInstanceOf(SlackApiError)
  })

  it('forwards setAssistantThreadStatus arguments and result', async () => {
    const mock = buildMockClient()
    mock.assistant.threads.setStatus.mockResolvedValue({ ok: true })
    const client = createSlackWebClient({
      botToken: 'xoxb',
      maxRetries: 0,
      client: asWebClient(mock),
    })
    const result = await client.setAssistantThreadStatus({
      channel_id: 'C1',
      thread_ts: '1700000000.000050',
      status: '考え中…',
    })
    expect({
      result,
      calls: mock.assistant.threads.setStatus.mock.calls,
    }).toEqual({
      result: { ok: true },
      calls: [
        [
          {
            channel_id: 'C1',
            thread_ts: '1700000000.000050',
            status: '考え中…',
          },
        ],
      ],
    })
  })

  it('rethrows setAssistantThreadStatus failures as SlackApiError', async () => {
    const mock = buildMockClient()
    const slackErr = new Error('platform error') as Error & {
      data: { error: string }
    }
    slackErr.data = { error: 'channel_not_supported' }
    mock.assistant.threads.setStatus.mockRejectedValue(slackErr)
    const client = createSlackWebClient({
      botToken: 'xoxb',
      maxRetries: 0,
      client: asWebClient(mock),
    })
    await expect(
      client.setAssistantThreadStatus({
        channel_id: 'C1',
        thread_ts: '1700000000.000050',
        status: '考え中…',
      }),
    ).rejects.toMatchObject({
      name: 'SlackApiError',
      slackError: 'channel_not_supported',
    })
  })

  it('throws SlackApiError when response_url returns non-2xx', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('boom', { status: 500 }),
    )
    const mock = buildMockClient()
    const client = createSlackWebClient({
      botToken: 'xoxb',
      maxRetries: 0,
      client: asWebClient(mock),
      fetchImpl,
    })
    await expect(
      client.postToResponseUrl('https://hooks.slack.com/actions/abc', {
        text: 'hi',
      }),
    ).rejects.toMatchObject({ name: 'SlackApiError', status: 500 })
  })
})
