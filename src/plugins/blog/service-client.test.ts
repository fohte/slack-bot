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

// Verifies both halves of the boundary contract for a single failure in one
// call: the exact error re-thrown to the caller, and the exact Sentry report
// captured for it (same error instance, same fingerprint, same extras).
const expectReportedFailure = async (
  promise: Promise<unknown>,
  expectedError: Error,
  extras: Record<string, unknown>,
): Promise<void> => {
  const thrown = await promise.catch((err: unknown) => err)
  expect(thrown).toEqual(expectedError)
  expect(vi.mocked(captureWithFingerprint).mock.calls).toEqual([
    [thrown, BLOG_SERVICE_CLIENT_FINGERPRINT, { extras }],
  ])
}

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

  it('converts HTTP 4xx to ServiceError with code/message and reports it to Sentry', async () => {
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
    await expectReportedFailure(
      client.buildPlan(['a']),
      new ServiceError('oh no', {
        status: 400,
        code: 'Bad',
        issues: undefined,
        traceId: undefined,
      }),
      { method: 'POST', path: '/plan' },
    )
  })

  it('converts HTTP 5xx to ServiceError and reports it to Sentry', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch
    const client = createBlogServiceClient({
      baseUrl: 'https://svc',
      bearerToken: 't',
      fetchImpl,
    })
    await expectReportedFailure(
      client.listNotes(),
      new ServiceError('boom', {
        status: 500,
        code: 'UnknownError',
        issues: undefined,
        traceId: undefined,
      }),
      { method: 'GET', path: '/notes' },
    )
  })

  it('throws ServiceUnavailable on network error and reports it to Sentry', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network down')
    }) as unknown as typeof fetch
    const client = createBlogServiceClient({
      baseUrl: 'https://svc',
      bearerToken: 't',
      fetchImpl,
    })
    await expectReportedFailure(
      client.listNotes(),
      new ServiceUnavailable(
        'Failed to reach blog-publisher service: network down',
        { cause: new TypeError('network down'), traceId: undefined },
      ),
      { method: 'GET', path: '/notes' },
    )
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
