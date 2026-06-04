import type { PlanIssue } from '@fohte/blog-publisher-contract'

export class ServiceError extends Error {
  override readonly name = 'ServiceError'
  readonly status: number
  readonly code: string
  readonly issues: readonly PlanIssue[] | undefined
  readonly traceId: string | undefined
  constructor(
    message: string,
    options: {
      status: number
      code: string
      issues?: readonly PlanIssue[] | undefined
      traceId?: string | undefined
    },
  ) {
    super(message)
    this.status = options.status
    this.code = options.code
    this.issues = options.issues
    this.traceId = options.traceId
  }
}

export class ServiceUnavailable extends Error {
  override readonly name = 'ServiceUnavailable'
  override readonly cause: unknown
  readonly traceId: string | undefined
  constructor(
    message: string,
    options: { cause?: unknown; traceId?: string | undefined } = {},
  ) {
    super(message)
    this.cause = options.cause
    this.traceId = options.traceId
  }
}

export class ButtonValueOverflow extends Error {
  override readonly name = 'ButtonValueOverflow'
  readonly size: number
  readonly limit: number
  constructor(size: number, limit: number) {
    super(
      `Button value exceeds Slack's ${String(limit)} character limit (got ${String(size)})`,
    )
    this.size = size
    this.limit = limit
  }
}
