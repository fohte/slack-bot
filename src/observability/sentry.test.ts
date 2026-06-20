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
  init: vi.fn(),
  withScope: (cb: (s: typeof scope) => unknown) => cb(scope),
  captureException: (err: unknown) => {
    captured.errors.push(err)
    return 'event-id'
  },
}))

const {
  captureGoUsageLimitError,
  initSentry,
  isSentryConfigured,
  redactEvent,
} = await import('@/observability/sentry')

beforeEach(() => {
  captured.fingerprints = []
  captured.levels = []
  captured.tags = {}
  captured.errors = []
})

describe('isSentryConfigured', () => {
  it('returns based on SENTRY_DSN presence', () => {
    expect({
      withDsn: isSentryConfigured({ SENTRY_DSN: 'https://x@y/1' }),
      emptyDsn: isSentryConfigured({ SENTRY_DSN: '' }),
      missing: isSentryConfigured({}),
    }).toEqual({
      withDsn: true,
      emptyDsn: false,
      missing: false,
    })
  })
})

describe('initSentry', () => {
  it('returns undefined when SENTRY_DSN is missing', () => {
    expect(initSentry({})).toBeUndefined()
  })
})

describe('redactEvent', () => {
  it('redacts authorization header, secret-like keys, and truncates Slack message body', () => {
    const longMessage = 'a'.repeat(250)
    const input = {
      request: {
        headers: {
          Authorization: 'Bearer secret-token',
          'content-type': 'application/json',
        },
      },
      contexts: {
        slack: {
          message: longMessage,
          channel: 'C123',
          nested: {
            SLACK_BOT_TOKEN: 'xoxb-1234',
            user_id: 'U123',
          },
        },
      },
      extra: {
        SENTRY_DSN: 'https://x@y/1',
        OPENAI_API_KEY: 'sk-abc',
        access_token: 'xoxb-lower',
        otherTags: ['ok'],
      },
    }

    expect(redactEvent(input)).toEqual({
      request: {
        headers: {
          Authorization: '[REDACTED]',
          'content-type': 'application/json',
        },
      },
      contexts: {
        slack: {
          message: 'a'.repeat(200),
          channel: 'C123',
          nested: {
            SLACK_BOT_TOKEN: '[REDACTED]',
            user_id: 'U123',
          },
        },
      },
      extra: {
        SENTRY_DSN: '[REDACTED]',
        OPENAI_API_KEY: '[REDACTED]',
        access_token: '[REDACTED]',
        otherTags: ['ok'],
      },
    })
  })

  it('does not mutate the input event', () => {
    const input = {
      request: { headers: { Authorization: 'Bearer x' } },
      extra: { SENTRY_DSN: 'dsn' },
    }
    redactEvent(input)
    expect(input).toEqual({
      request: { headers: { Authorization: 'Bearer x' } },
      extra: { SENTRY_DSN: 'dsn' },
    })
  })
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
