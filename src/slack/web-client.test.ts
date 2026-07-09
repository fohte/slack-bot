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
  files: {
    info: ReturnType<typeof vi.fn>
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
  files: {
    info: vi.fn(),
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
      status: 'is thinking...',
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
            status: 'is thinking...',
          },
        ],
      ],
    })
  })

  it('forwards setAssistantThreadStatus loading_messages to the underlying client', async () => {
    const mock = buildMockClient()
    mock.assistant.threads.setStatus.mockResolvedValue({ ok: true })
    const client = createSlackWebClient({
      botToken: 'xoxb',
      maxRetries: 0,
      client: asWebClient(mock),
    })
    await client.setAssistantThreadStatus({
      channel_id: 'C1',
      thread_ts: '1700000000.000050',
      status: 'is thinking...',
      loading_messages: ['Preparing your task…'],
    })
    expect(mock.assistant.threads.setStatus.mock.calls).toEqual([
      [
        {
          channel_id: 'C1',
          thread_ts: '1700000000.000050',
          status: 'is thinking...',
          loading_messages: ['Preparing your task…'],
        },
      ],
    ])
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
        status: 'is thinking...',
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

  it('downloads a Slack file with the bot token as Bearer auth', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    )
    const mock = buildMockClient()
    const client = createSlackWebClient({
      botToken: 'xoxb-secret',
      maxRetries: 0,
      client: asWebClient(mock),
      fetchImpl,
    })
    const result = await client.downloadFile(
      'https://files.slack.com/files-pri/T1-F1/image.png',
    )
    expect({
      fetchCalls: fetchImpl.mock.calls.map(([url, init]) => ({
        url,
        method: (init as RequestInit | undefined)?.method,
        auth: (
          (init as RequestInit | undefined)?.headers as
            | Record<string, string>
            | undefined
        )?.['Authorization'],
      })),
      contentType: result.contentType,
      bytes: Array.from(result.bytes),
    }).toEqual({
      fetchCalls: [
        {
          url: 'https://files.slack.com/files-pri/T1-F1/image.png',
          method: 'GET',
          auth: 'Bearer xoxb-secret',
        },
      ],
      contentType: 'image/png',
      bytes: [0x89, 0x50, 0x4e, 0x47],
    })
  })

  it('refuses to download from a non-Slack host without calling fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('', { status: 200 }),
    )
    const mock = buildMockClient()
    const client = createSlackWebClient({
      botToken: 'xoxb-secret',
      maxRetries: 0,
      client: asWebClient(mock),
      fetchImpl,
    })
    await expect(
      client.downloadFile('https://evil.example.com/files/x.png'),
    ).rejects.toMatchObject({ name: 'SlackApiError' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects responses whose Content-Length exceeds the OOM guard before buffering', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response('', {
          status: 200,
          headers: { 'content-length': String(20 * 1024 * 1024) },
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
      client.downloadFile('https://files.slack.com/big.png'),
    ).rejects.toMatchObject({ name: 'SlackApiError' })
  })

  it('throws SlackApiError when file download returns non-2xx', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('forbidden', { status: 403 }),
    )
    const mock = buildMockClient()
    const client = createSlackWebClient({
      botToken: 'xoxb',
      maxRetries: 0,
      client: asWebClient(mock),
      fetchImpl,
    })
    await expect(
      client.downloadFile('https://files.slack.com/files-pri/T1-F1/x.png'),
    ).rejects.toMatchObject({ name: 'SlackApiError', status: 403 })
  })

  it('maps files.info result to a SlackFile', async () => {
    const mock = buildMockClient()
    mock.files.info.mockResolvedValue({
      ok: true,
      file: {
        id: 'F123',
        name: 'lunch.jpg',
        title: 'lunch',
        mimetype: 'image/jpeg',
        filetype: 'jpg',
        size: 1234,
        url_private: 'https://files.slack.com/files-pri/T1-F123/lunch.jpg',
        url_private_download:
          'https://files.slack.com/files-pri/T1-F123/download/lunch.jpg',
        permalink: 'https://team.slack.com/files/U1/F123/lunch.jpg',
        channels: ['C1'],
        groups: ['G1'],
        ims: [],
      },
    })
    const client = createSlackWebClient({
      botToken: 'xoxb',
      maxRetries: 0,
      client: asWebClient(mock),
    })
    const result = await client.getFileInfo('F123')
    expect({ result, calls: mock.files.info.mock.calls }).toEqual({
      result: {
        id: 'F123',
        name: 'lunch.jpg',
        title: 'lunch',
        mimetype: 'image/jpeg',
        filetype: 'jpg',
        size: 1234,
        url_private: 'https://files.slack.com/files-pri/T1-F123/lunch.jpg',
        url_private_download:
          'https://files.slack.com/files-pri/T1-F123/download/lunch.jpg',
        permalink: 'https://team.slack.com/files/U1/F123/lunch.jpg',
        channels: ['C1'],
        groups: ['G1'],
        ims: [],
      },
      calls: [[{ file: 'F123' }]],
    })
  })

  it('returns undefined when files.info responds with a null file', async () => {
    const mock = buildMockClient()
    mock.files.info.mockResolvedValue({ ok: true, file: null })
    const client = createSlackWebClient({
      botToken: 'xoxb',
      maxRetries: 0,
      client: asWebClient(mock),
    })
    await expect(client.getFileInfo('F123')).resolves.toBeUndefined()
  })

  it('rethrows files.info failures as SlackApiError', async () => {
    const mock = buildMockClient()
    const slackErr = new Error('platform error') as Error & {
      data: { error: string }
    }
    slackErr.data = { error: 'file_not_found' }
    mock.files.info.mockRejectedValue(slackErr)
    const client = createSlackWebClient({
      botToken: 'xoxb',
      maxRetries: 0,
      client: asWebClient(mock),
    })
    await expect(client.getFileInfo('F123')).rejects.toMatchObject({
      name: 'SlackApiError',
      slackError: 'file_not_found',
    })
  })
})
