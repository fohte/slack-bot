import { captureWithFingerprint } from '@fohte/service-kit/observability'
import type { WebClient } from '@slack/web-api'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createSlackWebClient,
  SLACK_FILE_DOWNLOAD_MAX_BYTES,
} from '#slack/web-client'
import { SlackApiError } from '#types/errors'

vi.mock('@fohte/service-kit/observability', () => ({
  captureWithFingerprint: vi.fn(),
}))

const SLACK_WEB_CLIENT_FINGERPRINT = 'slack.web-client.request-failed'

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

// Verifies both halves of the boundary contract for a single failure in one
// call: the exact error re-thrown to the caller, and the exact Sentry report
// captured for it (same error instance, same fingerprint, same extras).
const expectReportedFailure = async (
  promise: Promise<unknown>,
  expectedError: SlackApiError,
  extras: Record<string, unknown>,
): Promise<void> => {
  const thrown = await promise.catch((err: unknown) => err)
  expect(thrown).toEqual(expectedError)
  expect(vi.mocked(captureWithFingerprint).mock.calls).toEqual([
    [thrown, SLACK_WEB_CLIENT_FINGERPRINT, { extras }],
  ])
}

describe('SlackWebClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

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

  it('rethrows underlying errors as SlackApiError and reports them to Sentry', async () => {
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
    const promise = client.postMessage({ channel: 'C1', text: 'hi' })
    await expectReportedFailure(
      promise,
      new SlackApiError('platform error', {
        slackError: 'channel_not_found',
        cause: slackErr,
      }),
      { method: 'chat.postMessage' },
    )
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

  it('throws SlackApiError when response_url returns ok:false and reports it to Sentry without the response_url', async () => {
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
    const promise = client.postToResponseUrl(
      'https://hooks.slack.com/actions/abc',
      { text: 'hi' },
    )
    await expectReportedFailure(
      promise,
      new SlackApiError('response_url returned error: expired_url', {
        slackError: 'expired_url',
        status: 200,
      }),
      { method: 'postToResponseUrl' },
    )
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
    expect(result).toEqual({ ok: true })
    expect(mock.assistant.threads.setStatus.mock.calls).toEqual([
      [
        {
          channel_id: 'C1',
          thread_ts: '1700000000.000050',
          status: 'is thinking...',
        },
      ],
    ])
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

  it('rethrows setAssistantThreadStatus failures as SlackApiError and reports them to Sentry', async () => {
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
    const promise = client.setAssistantThreadStatus({
      channel_id: 'C1',
      thread_ts: '1700000000.000050',
      status: 'is thinking...',
    })
    await expectReportedFailure(
      promise,
      new SlackApiError('platform error', {
        slackError: 'channel_not_supported',
        cause: slackErr,
      }),
      { method: 'assistant.threads.setStatus' },
    )
  })

  it('throws SlackApiError when response_url returns non-2xx and reports it to Sentry without the response_url', async () => {
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
    const promise = client.postToResponseUrl(
      'https://hooks.slack.com/actions/abc',
      { text: 'hi' },
    )
    await expectReportedFailure(
      promise,
      new SlackApiError('response_url POST failed with HTTP 500', {
        status: 500,
      }),
      { method: 'postToResponseUrl' },
    )
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
    expect(
      fetchImpl.mock.calls.map(([url, init]) => ({
        url,
        method: (init as RequestInit | undefined)?.method,
        auth: (
          (init as RequestInit | undefined)?.headers as
            Record<string, string> | undefined
        )?.['Authorization'],
      })),
    ).toEqual([
      {
        url: 'https://files.slack.com/files-pri/T1-F1/image.png',
        method: 'GET',
        auth: 'Bearer xoxb-secret',
      },
    ])
    expect(result).toEqual({
      contentType: 'image/png',
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    })
  })

  it('refuses to download from a non-Slack host without calling fetch, and reports it to Sentry', async () => {
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
    const promise = client.downloadFile('https://evil.example.com/files/x.png')
    await expectReportedFailure(
      promise,
      new SlackApiError(
        'refusing to download non-Slack URL: evil.example.com',
        {},
      ),
      {
        method: 'downloadFile',
        url: 'https://evil.example.com/files/x.png',
      },
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects responses whose Content-Length exceeds the OOM guard before buffering, and reports it to Sentry', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response('', {
          status: 200,
          headers: { 'content-length': String(40 * 1024 * 1024) },
        }),
    )
    const mock = buildMockClient()
    const client = createSlackWebClient({
      botToken: 'xoxb',
      maxRetries: 0,
      client: asWebClient(mock),
      fetchImpl,
    })
    const promise = client.downloadFile('https://files.slack.com/big.png')
    await expectReportedFailure(
      promise,
      new SlackApiError(
        `slack file too large: ${40 * 1024 * 1024} bytes (cap ${SLACK_FILE_DOWNLOAD_MAX_BYTES})`,
        { status: 200 },
      ),
      { method: 'downloadFile', url: 'https://files.slack.com/big.png' },
    )
  })

  it('throws SlackApiError when file download returns non-2xx, and reports it to Sentry', async () => {
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
    const promise = client.downloadFile(
      'https://files.slack.com/files-pri/T1-F1/x.png',
    )
    await expectReportedFailure(
      promise,
      new SlackApiError('slack file download failed with HTTP 403', {
        status: 403,
      }),
      {
        method: 'downloadFile',
        url: 'https://files.slack.com/files-pri/T1-F1/x.png',
      },
    )
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
    expect(result).toEqual({
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
    })
    expect(mock.files.info.mock.calls).toEqual([[{ file: 'F123' }]])
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

  it('rethrows files.info failures as SlackApiError and reports them to Sentry', async () => {
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
    const promise = client.getFileInfo('F123')
    await expectReportedFailure(
      promise,
      new SlackApiError('platform error', {
        slackError: 'file_not_found',
        cause: slackErr,
      }),
      { method: 'files.info' },
    )
  })
})
