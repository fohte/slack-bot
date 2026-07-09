import type { Attributes } from '@opentelemetry/api'
import { metrics, SpanStatusCode, trace } from '@opentelemetry/api'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Counters from '@/observability/counters'

// Counters lazily cache the OTel instruments on first use. Each test resets
// modules and re-imports so the lazy cache picks up the test-local provider
// instead of a stale (or noop) instrument from a prior test.
let GoUsageLimitError: typeof Counters.GoUsageLimitError
let recordRateLimited: typeof Counters.recordRateLimited
let wrapOpencodeCall: typeof Counters.wrapOpencodeCall

const importCounters = async (): Promise<void> => {
  vi.resetModules()
  const mod = await import('@/observability/counters')
  GoUsageLimitError = mod.GoUsageLimitError
  recordRateLimited = mod.recordRateLimited
  wrapOpencodeCall = mod.wrapOpencodeCall
}

interface MetricRow {
  readonly name: string
  readonly attributes: Attributes
  readonly value: number
}

interface SpanRow {
  readonly name: string
  readonly attributes: Attributes
  readonly statusCode: SpanStatusCode
}

interface Snapshot {
  readonly spans: readonly SpanRow[]
  readonly messages: readonly MetricRow[]
  readonly calls: readonly MetricRow[]
}

let spanExporter: InMemorySpanExporter
let tracerProvider: BasicTracerProvider
let metricExporter: InMemoryMetricExporter
let meterProvider: MeterProvider

const setupObservability = (): void => {
  spanExporter = new InMemorySpanExporter()
  tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  })
  trace.setGlobalTracerProvider(tracerProvider)

  metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  meterProvider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 60_000,
      }),
    ],
  })
  metrics.setGlobalMeterProvider(meterProvider)
}

const teardownObservability = async (): Promise<void> => {
  await tracerProvider.shutdown()
  await meterProvider.shutdown()
  trace.disable()
  metrics.disable()
}

const collect = async (): Promise<Snapshot> => {
  await tracerProvider.forceFlush()
  await meterProvider.forceFlush()
  const spans: SpanRow[] = spanExporter.getFinishedSpans().map((s) => ({
    name: s.name,
    attributes: s.attributes,
    statusCode: s.status.code,
  }))
  const messages: MetricRow[] = []
  const calls: MetricRow[] = []
  for (const rm of metricExporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        for (const p of m.dataPoints) {
          const row: MetricRow = {
            name: m.descriptor.name,
            attributes: p.attributes,
            value: p.value as number,
          }
          if (m.descriptor.name === 'opencode.messages.count') {
            messages.push(row)
          } else if (m.descriptor.name === 'opencode.calls.count') {
            calls.push(row)
          }
        }
      }
    }
  }
  return { spans, messages, calls }
}

describe('wrapOpencodeCall', () => {
  beforeEach(async () => {
    setupObservability()
    await importCounters()
  })
  afterEach(async () => {
    await teardownObservability()
  })

  it('records a success span with model and increments counters', async () => {
    const result = await wrapOpencodeCall(
      { sessionId: 'sess_abc', operation: 'fetch_messages' },
      async () => ({ reply: 'hi' }),
      () => ({ models: ['opencode-go/claude-sonnet-4-6'], assistantCount: 1 }),
    )

    const actual = { result, snapshot: await collect() }
    expect(actual).toEqual({
      result: { reply: 'hi' },
      snapshot: {
        spans: [
          {
            name: 'opencode.message',
            attributes: {
              'opencode.session_id': 'sess_abc',
              'opencode.operation': 'fetch_messages',
              'opencode.model': 'opencode-go/claude-sonnet-4-6',
              'opencode.status': 'success',
              'opencode.assistant_count': 1,
              'http.status_code': 200,
            },
            statusCode: SpanStatusCode.UNSET,
          },
        ],
        messages: [
          {
            name: 'opencode.messages.count',
            attributes: {
              model: 'opencode-go/claude-sonnet-4-6',
              status: 'success',
            },
            value: 1,
          },
        ],
        calls: [
          {
            name: 'opencode.calls.count',
            attributes: {
              operation: 'fetch_messages',
              status: 'success',
              http_status_code: 200,
            },
            value: 1,
          },
        ],
      },
    })
  })

  it('classifies a generic exception as error and increments error counters', async () => {
    const err = new Error('boom')
    let thrown: unknown
    try {
      await wrapOpencodeCall(
        { sessionId: 'sess_abc', operation: 'fetch_messages' },
        async () => {
          throw err
        },
        () => ({ models: [], assistantCount: 0 }),
      )
    } catch (e) {
      thrown = e
    }

    const actual = { thrown, snapshot: await collect() }
    expect(actual).toEqual({
      thrown: err,
      snapshot: {
        spans: [
          {
            name: 'opencode.message',
            attributes: {
              'opencode.session_id': 'sess_abc',
              'opencode.operation': 'fetch_messages',
              'opencode.model': 'unknown',
              'opencode.status': 'error',
            },
            statusCode: SpanStatusCode.ERROR,
          },
        ],
        messages: [
          {
            name: 'opencode.messages.count',
            attributes: { model: 'unknown', status: 'error' },
            value: 1,
          },
        ],
        calls: [
          {
            name: 'opencode.calls.count',
            attributes: { operation: 'fetch_messages', status: 'error' },
            value: 1,
          },
        ],
      },
    })
  })

  it('classifies GoUsageLimitError as rate_limited and uses recordRateLimited for the message counter', async () => {
    const err = new GoUsageLimitError('rate limited', { retryAfter: 30 })
    let thrown: unknown
    try {
      await wrapOpencodeCall(
        { sessionId: 'sess_abc', operation: 'fetch_messages' },
        async () => {
          recordRateLimited({ retryAfter: 30 })
          throw err
        },
        () => ({ models: [], assistantCount: 0 }),
      )
    } catch (e) {
      thrown = e
    }

    const actual = { thrown, snapshot: await collect() }
    expect(actual).toEqual({
      thrown: err,
      snapshot: {
        spans: [
          {
            name: 'opencode.message',
            attributes: {
              'opencode.session_id': 'sess_abc',
              'opencode.operation': 'fetch_messages',
              'opencode.model': 'unknown',
              'opencode.status': 'rate_limited',
              'http.status_code': 429,
              'http.retry_after': 30,
              'error.type': 'GoUsageLimitError',
            },
            statusCode: SpanStatusCode.ERROR,
          },
        ],
        messages: [
          {
            name: 'opencode.messages.count',
            attributes: { model: 'unknown', status: 'rate_limited' },
            value: 1,
          },
        ],
        calls: [
          {
            name: 'opencode.calls.count',
            attributes: {
              operation: 'fetch_messages',
              status: 'rate_limited',
              http_status_code: 429,
            },
            value: 1,
          },
        ],
      },
    })
  })

  it('falls back to model=unknown when classifyResponse returns no models', async () => {
    const result = await wrapOpencodeCall(
      { sessionId: 'sess_xyz', operation: 'find_session' },
      async () => ({ ok: true }),
      () => ({ models: [], assistantCount: 1 }),
    )

    const actual = { result, snapshot: await collect() }
    expect(actual).toEqual({
      result: { ok: true },
      snapshot: {
        spans: [
          {
            name: 'opencode.message',
            attributes: {
              'opencode.session_id': 'sess_xyz',
              'opencode.operation': 'find_session',
              'opencode.model': 'unknown',
              'opencode.status': 'success',
              'opencode.assistant_count': 1,
              'http.status_code': 200,
            },
            statusCode: SpanStatusCode.UNSET,
          },
        ],
        messages: [
          {
            name: 'opencode.messages.count',
            attributes: { model: 'unknown', status: 'success' },
            value: 1,
          },
        ],
        calls: [
          {
            name: 'opencode.calls.count',
            attributes: {
              operation: 'find_session',
              status: 'success',
              http_status_code: 200,
            },
            value: 1,
          },
        ],
      },
    })
  })
})

describe('wrapOpencodeCall without observability initialized', () => {
  beforeEach(async () => {
    trace.disable()
    metrics.disable()
    await importCounters()
  })

  it('runs as a no-op and returns the wrapped result', async () => {
    let threw: unknown
    let result: unknown
    try {
      result = await wrapOpencodeCall(
        { sessionId: 'sess_noop', operation: 'fetch_messages' },
        async () => ({ ok: true }),
        () => ({ models: ['m'], assistantCount: 1 }),
      )
      recordRateLimited({ retryAfter: 1 })
    } catch (e) {
      threw = e
    }

    const actual = { result, threw }
    expect(actual).toEqual({
      result: { ok: true },
      threw: undefined,
    })
  })
})
