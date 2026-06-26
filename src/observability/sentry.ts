import * as Sentry from '@sentry/node'

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
