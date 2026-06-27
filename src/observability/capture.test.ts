import { beforeEach, describe, expect, it, vi } from 'vitest'

interface CapturedScopeCalls {
  fingerprints: unknown[]
  levels: unknown[]
  tags: Record<string, unknown>
  errors: unknown[]
}

const captured: CapturedScopeCalls = {
  fingerprints: [],
  levels: [],
  tags: {},
  errors: [],
}

const scope = {
  setFingerprint: (fp: unknown) => {
    captured.fingerprints.push(fp)
    return scope
  },
  setLevel: (level: unknown) => {
    captured.levels.push(level)
    return scope
  },
  setTag: (key: string, value: unknown) => {
    captured.tags[key] = value
    return scope
  },
}

vi.mock('@sentry/node', () => ({
  withScope: (cb: (s: typeof scope) => unknown) => cb(scope),
  captureException: (err: unknown) => {
    captured.errors.push(err)
    return 'event-id'
  },
}))

const { captureGoUsageLimitError } = await import('@/observability/capture')

beforeEach(() => {
  captured.fingerprints = []
  captured.levels = []
  captured.tags = {}
  captured.errors = []
})

describe('captureGoUsageLimitError', () => {
  it('forwards the error to Sentry with fingerprint, tags, and warning level', () => {
    const err = new Error('go usage limit')
    captureGoUsageLimitError(err, { retryAfter: 42 })

    expect(captured).toEqual({
      fingerprints: [['opencode-go-usage-limit']],
      levels: ['warning'],
      tags: {
        error_type: 'GoUsageLimitError',
        retry_after_seconds: '42',
      },
      errors: [err],
    })
  })

  it('omits retry_after_seconds tag when retryAfter is not provided', () => {
    const err = new Error('go usage limit')
    captureGoUsageLimitError(err)

    expect(captured).toEqual({
      fingerprints: [['opencode-go-usage-limit']],
      levels: ['warning'],
      tags: {
        error_type: 'GoUsageLimitError',
      },
      errors: [err],
    })
  })
})
