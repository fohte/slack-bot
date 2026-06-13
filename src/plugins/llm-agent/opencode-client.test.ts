import { describe, expect, it } from 'vitest'

import { createOpencodeClient } from '@/plugins/llm-agent/opencode-client'

const buildFetch = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

const noopSleep = async (): Promise<void> => {}

describe('createOpencodeClient', () => {
  it('returns the concatenated text parts of the latest assistant message', async () => {
    const client = createOpencodeClient({
      baseUrl: 'http://opencode.test',
      fetchImpl: buildFetch([
        {
          info: { role: 'user' },
          parts: [{ type: 'text', text: 'hi' }],
        },
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'world' },
          ],
        },
      ]),
      maxAttempts: 1,
    })
    expect(await client.fetchLatestAssistantText('ses_1')).toBe('Hello world')
  })

  it('returns undefined when no assistant message is present', async () => {
    const client = createOpencodeClient({
      fetchImpl: buildFetch([
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
      ]),
      maxAttempts: 1,
    })
    expect(await client.fetchLatestAssistantText('ses_1')).toBeUndefined()
  })

  it('throws after exhausting retries on persistent 5xx', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = (async () => {
      calls += 1
      return new Response('{}', { status: 500 })
    }) as unknown as typeof fetch
    const client = createOpencodeClient({
      fetchImpl,
      maxAttempts: 3,
      sleepImpl: noopSleep,
    })
    await expect(client.fetchLatestAssistantText('ses_1')).rejects.toThrow(
      /HTTP 500/,
    )
    expect(calls).toBe(3)
  })

  it('retries transient failures and returns the assistant text on success', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = (async () => {
      calls += 1
      if (calls < 3) return new Response('{}', { status: 503 })
      return new Response(
        JSON.stringify([
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'OK' }],
          },
        ]),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const client = createOpencodeClient({
      fetchImpl,
      maxAttempts: 3,
      sleepImpl: noopSleep,
    })
    expect(await client.fetchLatestAssistantText('ses_1')).toBe('OK')
    expect(calls).toBe(3)
  })

  it('throws when the response payload is not an array', async () => {
    const client = createOpencodeClient({
      fetchImpl: buildFetch({ not: 'an array' }),
      maxAttempts: 1,
    })
    await expect(client.fetchLatestAssistantText('ses_1')).rejects.toThrow(
      /non-array payload/,
    )
  })
})
