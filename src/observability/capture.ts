import { captureWithFingerprint } from '@fohte/service-kit/observability'

export interface CaptureGoUsageLimitContext {
  readonly retryAfter?: number | undefined
}

export const captureGoUsageLimitError = (
  err: Error,
  context: CaptureGoUsageLimitContext = {},
): void => {
  const tags: Record<string, string> = { error_type: 'GoUsageLimitError' }
  if (typeof context.retryAfter === 'number') {
    tags['retry_after_seconds'] = String(context.retryAfter)
  }
  captureWithFingerprint(err, 'opencode-go-usage-limit', {
    level: 'warning',
    tags,
  })
}
