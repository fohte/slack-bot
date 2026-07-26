import { captureWithFingerprint } from '@fohte/service-kit/observability'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ServiceError, ServiceUnavailable } from '@/plugins/blog/errors'
import { createBlogServiceClient } from '@/plugins/blog/service-client'

vi.mock('@fohte/service-kit/observability', () => ({
  captureWithFingerprint: vi.fn(),
}))

const BLOG_SERVICE_CLIENT_FINGERPRINT = 'blog.service-client.request-failed'

const okJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.catch((err: unknown) => err)

describe('BlogServiceClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

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

  describe('when buildPlan receives an HTTP 4xx response', () => {
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

    it('converts it to ServiceError with code/message', async () => {
      const thrown = await rejectionOf(client.buildPlan(['a']))
      expect(thrown).toEqual(
        new ServiceError('oh no', {
          status: 400,
          code: 'Bad',
          issues: undefined,
          traceId: undefined,
        }),
      )
    })

    it('reports it to Sentry', async () => {
      const thrown = await rejectionOf(client.buildPlan(['a']))
      expect(vi.mocked(captureWithFingerprint).mock.calls).toEqual([
        [
          thrown,
          BLOG_SERVICE_CLIENT_FINGERPRINT,
          { extras: { method: 'POST', path: '/plan' } },
        ],
      ])
    })
  })

  describe('when listNotes receives an HTTP 5xx response', () => {
    const fetchImpl = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch
    const client = createBlogServiceClient({
      baseUrl: 'https://svc',
      bearerToken: 't',
      fetchImpl,
    })

    it('converts it to ServiceError with code/message', async () => {
      const thrown = await rejectionOf(client.listNotes())
      expect(thrown).toEqual(
        new ServiceError('boom', {
          status: 500,
          code: 'UnknownError',
          issues: undefined,
          traceId: undefined,
        }),
      )
    })

    it('reports it to Sentry', async () => {
      const thrown = await rejectionOf(client.listNotes())
      expect(vi.mocked(captureWithFingerprint).mock.calls).toEqual([
        [
          thrown,
          BLOG_SERVICE_CLIENT_FINGERPRINT,
          { extras: { method: 'GET', path: '/notes' } },
        ],
      ])
    })
  })

  describe('when listNotes hits a network error', () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network down')
    }) as unknown as typeof fetch
    const client = createBlogServiceClient({
      baseUrl: 'https://svc',
      bearerToken: 't',
      fetchImpl,
    })

    it('converts it to ServiceUnavailable', async () => {
      const thrown = await rejectionOf(client.listNotes())
      expect(thrown).toEqual(
        new ServiceUnavailable(
          'Failed to reach blog-publisher service: network down',
          { cause: new TypeError('network down'), traceId: undefined },
        ),
      )
    })

    it('reports it to Sentry', async () => {
      const thrown = await rejectionOf(client.listNotes())
      expect(vi.mocked(captureWithFingerprint).mock.calls).toEqual([
        [
          thrown,
          BLOG_SERVICE_CLIENT_FINGERPRINT,
          { extras: { method: 'GET', path: '/notes' } },
        ],
      ])
    })
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
