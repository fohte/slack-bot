import type { Attributes, Counter } from '@opentelemetry/api'
import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api'

const INSTRUMENTATION_NAME = 'slack-bot'
const SPAN_NAME = 'opencode.message'
const UNKNOWN_MODEL = 'unknown'

export type OpencodeStatus = 'success' | 'error' | 'rate_limited'

export type OpencodeOperation = 'fetch_messages' | 'find_session'

export interface OpencodeCallContext {
  readonly sessionId: string
  readonly operation: OpencodeOperation
}

export interface ClassifiedOpencodeResponse {
  readonly models: readonly string[]
  readonly assistantCount: number
}

// Thrown by the opencode client when a 429 reaches the wrapper.
export class GoUsageLimitError extends Error {
  override readonly name = 'GoUsageLimitError'
  readonly retryAfter: number | undefined

  constructor(message: string, options: { retryAfter?: number } = {}) {
    super(message)
    this.retryAfter = options.retryAfter
  }
}

const getMessagesCounter = (): Counter =>
  metrics
    .getMeter(INSTRUMENTATION_NAME)
    .createCounter('opencode.messages.count', {
      description:
        'opencode assistant messages observed, partitioned by model and status',
      unit: '1',
    })

const getCallsCounter = (): Counter =>
  metrics.getMeter(INSTRUMENTATION_NAME).createCounter('opencode.calls.count', {
    description:
      'opencode HTTP calls, partitioned by operation, status, and HTTP status code',
    unit: '1',
  })

const isGoUsageLimitError = (
  err: unknown,
): err is { name: string; retryAfter?: number; message?: string } =>
  err instanceof Error && err.name === 'GoUsageLimitError'

const pickPrimaryModel = (models: readonly string[]): string => {
  for (const m of models) {
    if (typeof m === 'string' && m.length > 0) return m
  }
  return UNKNOWN_MODEL
}

// `models` is expected to align 1:1 with assistant messages. When the response
// returns fewer model IDs than messages (or none at all), the remaining
// messages are charged to `unknown` so the counter total still equals
// assistantCount.
const incrementMessagesPerModel = (
  models: readonly string[],
  assistantCount: number,
  status: OpencodeStatus,
): void => {
  if (assistantCount <= 0) return
  const counter = getMessagesCounter()
  for (let i = 0; i < assistantCount; i++) {
    const candidate = models[i]
    const labelModel =
      typeof candidate === 'string' && candidate.length > 0
        ? candidate
        : UNKNOWN_MODEL
    counter.add(1, { model: labelModel, status })
  }
}

const incrementCalls = (
  operation: OpencodeOperation,
  status: OpencodeStatus,
  httpStatusCode: number | undefined,
): void => {
  const attrs: Attributes = { operation, status }
  if (typeof httpStatusCode === 'number') {
    attrs['http_status_code'] = httpStatusCode
  }
  getCallsCounter().add(1, attrs)
}

export const recordRateLimited = (input: {
  readonly retryAfter?: number | undefined
  readonly model?: string | undefined
}): void => {
  const model =
    typeof input.model === 'string' && input.model.length > 0
      ? input.model
      : UNKNOWN_MODEL
  getMessagesCounter().add(1, { model, status: 'rate_limited' })
  if (typeof input.retryAfter === 'number') {
    trace.getActiveSpan()?.setAttribute('http.retry_after', input.retryAfter)
  }
}

export async function wrapOpencodeCall<T>(
  ctx: OpencodeCallContext,
  fn: () => Promise<T>,
  classifyResponse: (result: T) => ClassifiedOpencodeResponse,
): Promise<T> {
  const tracer = trace.getTracer(INSTRUMENTATION_NAME)
  const span = tracer.startSpan(SPAN_NAME, {
    attributes: {
      'opencode.session_id': ctx.sessionId,
      'opencode.operation': ctx.operation,
    },
  })
  const spanContext = trace.setSpan(context.active(), span)
  try {
    const result = await context.with(spanContext, fn)
    const classified = classifyResponse(result)
    const model = pickPrimaryModel(classified.models)
    span.setAttributes({
      'opencode.model': model,
      'opencode.status': 'success',
      'opencode.assistant_count': classified.assistantCount,
      'http.status_code': 200,
    })
    incrementMessagesPerModel(
      classified.models,
      classified.assistantCount,
      'success',
    )
    incrementCalls(ctx.operation, 'success', 200)
    span.end()
    return result
  } catch (err) {
    if (isGoUsageLimitError(err)) {
      span.setAttributes({
        'opencode.model': UNKNOWN_MODEL,
        'opencode.status': 'rate_limited',
        'http.status_code': 429,
        'error.type': 'GoUsageLimitError',
        ...(typeof err.retryAfter === 'number'
          ? { 'http.retry_after': err.retryAfter }
          : {}),
      })
      span.setStatus({ code: SpanStatusCode.ERROR })
      incrementCalls(ctx.operation, 'rate_limited', 429)
    } else {
      span.setAttributes({
        'opencode.model': UNKNOWN_MODEL,
        'opencode.status': 'error',
      })
      if (err instanceof Error) span.recordException(err)
      span.setStatus({ code: SpanStatusCode.ERROR })
      incrementMessagesPerModel([], 1, 'error')
      incrementCalls(ctx.operation, 'error', undefined)
    }
    span.end()
    throw err
  }
}
