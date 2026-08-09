import { describe, expect, it, vi } from 'vitest'

import type { LogFields, Logger } from '#logger/logger'
import { createRestoreSystemRoleFetch } from '#plugins/llm-agent/conversation-agent/restore-system-role-fetch'

const okResponse = () => new Response('{}', { status: 200 })

const createRecordingLogger = (): Logger & {
  readonly warnCalls: LogFields[]
} => {
  const warnCalls: LogFields[] = []
  return {
    warnCalls,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: (fields) => {
      warnCalls.push(fields)
    },
    error: () => undefined,
    fatal: () => undefined,
    child() {
      return this
    },
  }
}

// Parses a JSON-string body back into an object so a call can be compared
// against an expected value by deep equality rather than by the
// implementation's incidental key order in its re-serialized JSON string.
const withParsedBody = (
  call: [string | URL | Request, RequestInit | undefined],
): [string | URL | Request, unknown] => {
  const [input, init] = call
  return [
    input,
    init?.body === undefined
      ? init
      : { ...init, body: JSON.parse(init.body as string) as unknown },
  ]
}

describe('createRestoreSystemRoleFetch', () => {
  it('rewrites developer-role messages back to system before forwarding the request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse())
    const restoreSystemRoleFetch = createRestoreSystemRoleFetch({ fetchImpl })
    const requestBody = {
      model: 'gpt-5.6-luna',
      messages: [
        { role: 'developer', content: 'persona prompt' },
        { role: 'user', content: 'hello' },
      ],
    }

    await restoreSystemRoleFetch(
      'https://opencode.ai/zen/go/v1/chat/completions',
      { method: 'POST', body: JSON.stringify(requestBody) },
    )

    const call = fetchImpl.mock.calls[0]
    expect(call).toBeDefined()
    expect(withParsedBody(call as [string, RequestInit])).toEqual([
      'https://opencode.ai/zen/go/v1/chat/completions',
      {
        method: 'POST',
        body: {
          model: 'gpt-5.6-luna',
          messages: [
            { role: 'system', content: 'persona prompt' },
            { role: 'user', content: 'hello' },
          ],
        },
      },
    ])
  })

  it('passes through a request with no body unchanged', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse())
    const restoreSystemRoleFetch = createRestoreSystemRoleFetch({ fetchImpl })
    const init: RequestInit = { method: 'GET' }

    await restoreSystemRoleFetch('https://example.com', init)

    expect(fetchImpl.mock.calls[0]).toEqual(['https://example.com', init])
  })

  it('passes through an unparseable body unchanged', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse())
    const restoreSystemRoleFetch = createRestoreSystemRoleFetch({ fetchImpl })
    const init: RequestInit = { method: 'POST', body: 'not json' }

    await restoreSystemRoleFetch('https://example.com', init)

    expect(fetchImpl.mock.calls[0]).toEqual(['https://example.com', init])
  })

  it('leaves a body with no messages array unchanged', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse())
    const restoreSystemRoleFetch = createRestoreSystemRoleFetch({ fetchImpl })
    const init: RequestInit = {
      method: 'POST',
      body: JSON.stringify({ model: 'text-embedding-3-small', input: 'hello' }),
    }

    await restoreSystemRoleFetch('https://example.com', init)

    expect(fetchImpl.mock.calls[0]).toEqual(['https://example.com', init])
  })

  it('logs a warning when the request body has no messages array', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse())
    const logger = createRecordingLogger()
    const restoreSystemRoleFetch = createRestoreSystemRoleFetch({
      fetchImpl,
      logger,
    })

    await restoreSystemRoleFetch('https://example.com', {
      method: 'POST',
      body: JSON.stringify({ model: 'text-embedding-3-small', input: 'hello' }),
    })

    expect(logger.warnCalls).toEqual([
      { event: 'restore_system_role_fetch_unexpected_body_shape' },
    ])
  })

  it('does not log a warning when the request body has a messages array', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse())
    const logger = createRecordingLogger()
    const restoreSystemRoleFetch = createRestoreSystemRoleFetch({
      fetchImpl,
      logger,
    })

    await restoreSystemRoleFetch('https://example.com', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.6-luna',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(logger.warnCalls).toEqual([])
  })
})
