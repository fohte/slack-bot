import { describe, expect, it, vi } from 'vitest'

import { ServiceError, ServiceUnavailable } from '@/plugins/blog/errors'
import { createBlogServiceClient } from '@/plugins/blog/service-client'

const okJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('BlogServiceClient', () => {
  it('sends bearer token and trace id, parses response', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson([
        {
          docId: 'a',
          path: 'p',
          title: 't',
          kind: 'new',
          mtime: 1,
        },
      ]),
    ) as unknown as typeof fetch
    const client = createBlogServiceClient({
      baseUrl: 'https://svc/',
      bearerToken: 'tok',
      fetchImpl,
    })
    const notes = await client.listNotes('trace-1')
    expect(notes).toHaveLength(1)
    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>
    const [url, init] = mock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://svc/notes')
    const headers = init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer tok')
    expect(headers['x-trace-id']).toBe('trace-1')
  })

  it('converts HTTP 4xx to ServiceError with code/message', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'Bad', message: 'oh no' } }),
          { status: 400 },
        ),
    ) as unknown as typeof fetch
    const client = createBlogServiceClient({
      baseUrl: 'https://svc',
      bearerToken: 't',
      fetchImpl,
    })
    await expect(client.buildPlan(['a'])).rejects.toMatchObject({
      name: 'ServiceError',
      status: 400,
      code: 'Bad',
    })
  })

  it('converts HTTP 5xx to ServiceError', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch
    const client = createBlogServiceClient({
      baseUrl: 'https://svc',
      bearerToken: 't',
      fetchImpl,
    })
    await expect(client.listNotes()).rejects.toBeInstanceOf(ServiceError)
  })

  it('throws ServiceUnavailable on network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network down')
    }) as unknown as typeof fetch
    const client = createBlogServiceClient({
      baseUrl: 'https://svc',
      bearerToken: 't',
      fetchImpl,
    })
    await expect(client.listNotes()).rejects.toBeInstanceOf(ServiceUnavailable)
  })

  it('cancelPr posts to the right path', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ closed: true }),
    ) as unknown as typeof fetch
    const client = createBlogServiceClient({
      baseUrl: 'https://svc',
      bearerToken: 't',
      fetchImpl,
    })
    await client.cancelPr(42)
    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>
    const [url, init] = mock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://svc/prs/42/cancel')
    expect(init.method).toBe('POST')
  })
})
