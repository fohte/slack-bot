import type { ErrorEvent, NodeClient } from '@sentry/node'
import * as Sentry from '@sentry/node'

export interface ObservabilityEnv {
  readonly SENTRY_DSN?: string | undefined
  readonly SENTRY_ENVIRONMENT?: string | undefined
  readonly SENTRY_RELEASE?: string | undefined
}

export const NOISE_PATTERNS: ReadonlyArray<string | RegExp> = [
  'AbortError',
  /ECONNRESET/,
]

const REDACTED = '[REDACTED]'
const SLACK_MESSAGE_MAX_LENGTH = 200
const SECRET_KEY_PATTERN = /token|dsn|api[_-]?key|authorization|cookie/i
const SLACK_MESSAGE_KEY_PATTERN = /^(slack_)?message(_text|_body)?$/i

export const isSentryConfigured = (env: ObservabilityEnv): boolean =>
  typeof env.SENTRY_DSN === 'string' && env.SENTRY_DSN.length > 0

export const initSentry = (env: ObservabilityEnv): NodeClient | undefined => {
  if (!isSentryConfigured(env)) return undefined
  return Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: env.SENTRY_RELEASE,
    skipOpenTelemetrySetup: true,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- redactor keeps the ErrorEvent shape
    beforeSend: (event: ErrorEvent) => redactEvent(event) as ErrorEvent,
    ignoreErrors: [...NOISE_PATTERNS],
  })
}

export const redactEvent = (event: unknown): unknown => {
  if (!isRecord(event)) return event
  const visited = new WeakMap<object, Record<string, unknown>>()
  const cloned: Record<string, unknown> = { ...event }

  const request = cloned['request']
  if (isRecord(request)) {
    const headers = request['headers']
    if (isRecord(headers)) {
      cloned['request'] = {
        ...request,
        headers: redactAuthorization(headers),
      }
    }
  }
  const contexts = cloned['contexts']
  if (isRecord(contexts)) {
    cloned['contexts'] = redactContainer(contexts, visited)
  }
  const extra = cloned['extra']
  if (isRecord(extra)) {
    cloned['extra'] = redactContainer(extra, visited)
  }
  const breadcrumbs = cloned['breadcrumbs']
  if (Array.isArray(breadcrumbs)) {
    cloned['breadcrumbs'] = (breadcrumbs as unknown[]).map((entry): unknown =>
      isRecord(entry) ? redactContainer(entry, visited) : entry,
    )
  }
  return cloned
}

// Only plain objects are traversed — class instances (Date / RegExp / Error /
// logger handles) would lose their prototype if shallow-copied into `{}`.
const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export interface CaptureGoUsageLimitContext {
  readonly retryAfter?: number | undefined
}

export const captureGoUsageLimitError = (
  err: Error,
  context: CaptureGoUsageLimitContext = {},
): void => {
  Sentry.withScope((scope) => {
    scope.setFingerprint(['opencode-go-usage-limit'])
    scope.setLevel('warning')
    scope.setTag('error_type', 'GoUsageLimitError')
    if (typeof context.retryAfter === 'number') {
      scope.setTag('retry_after_seconds', String(context.retryAfter))
    }
    Sentry.captureException(err)
  })
}

const redactAuthorization = (
  headers: Record<string, unknown>,
): Record<string, unknown> => {
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(headers)) {
    next[key] = key.toLowerCase() === 'authorization' ? REDACTED : value
  }
  return next
}

const redactContainer = (
  container: Record<string, unknown>,
  visited: WeakMap<object, Record<string, unknown>>,
): Record<string, unknown> => {
  const cached = visited.get(container)
  if (cached) return cached

  const next: Record<string, unknown> = {}
  visited.set(container, next)

  for (const [key, value] of Object.entries(container)) {
    next[key] = redactValue(key, value, visited)
  }
  return next
}

const redactValue = (
  key: string,
  value: unknown,
  visited: WeakMap<object, Record<string, unknown>>,
): unknown => {
  if (SECRET_KEY_PATTERN.test(key)) return REDACTED
  if (SLACK_MESSAGE_KEY_PATTERN.test(key) && typeof value === 'string') {
    return truncate(value)
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(key, entry, visited))
  }
  if (isRecord(value)) {
    return redactContainer(value, visited)
  }
  return value
}

const truncate = (value: string): string =>
  value.length <= SLACK_MESSAGE_MAX_LENGTH
    ? value
    : value.slice(0, SLACK_MESSAGE_MAX_LENGTH)
