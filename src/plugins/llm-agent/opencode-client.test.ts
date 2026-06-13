import { describe, expect, it } from 'vitest'

import { createOpencodeClient } from '@/plugins/llm-agent/opencode-client'

const buildFetch = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

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
    })
    expect(await client.fetchLatestAssistantText('ses_1')).toBe('Hello world')
  })

  it('returns undefined when no assistant message is present', async () => {
    const client = createOpencodeClient({
      fetchImpl: buildFetch([
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
      ]),
    })
    expect(await client.fetchLatestAssistantText('ses_1')).toBeUndefined()
  })

  it('throws when the server returns a non-2xx status', async () => {
    const client = createOpencodeClient({ fetchImpl: buildFetch({}, 500) })
    await expect(client.fetchLatestAssistantText('ses_1')).rejects.toThrow(
      /HTTP 500/,
    )
  })
})
