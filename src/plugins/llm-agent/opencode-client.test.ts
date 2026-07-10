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
import type { MockInstance } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { captureGoUsageLimitError } from '@/observability/capture'

const buildFetch = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

const noopSleep = async (): Promise<void> => {}

// Counters lazily cache OTel instruments on first use, so the client module
// needs to be re-imported per test once a fresh provider is installed —
// otherwise the cached counter stays bound to the previous test's exporter
// (or the global noop). The capture spy is reattached after resetModules.
let createOpencodeClient: typeof import('@/plugins/llm-agent/opencode-client').createOpencodeClient
let captureSpy: MockInstance<typeof captureGoUsageLimitError>

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

const installProviders = async (): Promise<void> => {
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

  vi.resetModules()
  const capture = await import('@/observability/capture')
  captureSpy = vi
    .spyOn(capture, 'captureGoUsageLimitError')
    .mockImplementation(() => {})
  const mod = await import('@/plugins/llm-agent/opencode-client')
  createOpencodeClient = mod.createOpencodeClient
}

const tearDown = async (): Promise<void> => {
  await tracerProvider.shutdown()
  await meterProvider.shutdown()
  trace.disable()
  metrics.disable()
  captureSpy.mockRestore()
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

describe('createOpencodeClient', () => {
  beforeEach(async () => {
    await installProviders()
  })
  afterEach(async () => {
    await tearDown()
  })

  it('returns the concatenated text parts of the latest assistant message', async () => {
    const client = createOpencodeClient({
      baseUrl: 'http://opencode.test',
      fetchImpl: buildFetch([
        {
          info: { role: 'user' },
          parts: [{ type: 'text', text: 'hi' }],
        },
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'world' },
          ],
        },
      ]),
      maxAttempts: 1,
    })
    expect(await client.fetchLatestAssistantText('ses_1')).toBe('Hello world')
  })

  it('returns undefined when no assistant message is present', async () => {
    const client = createOpencodeClient({
      fetchImpl: buildFetch([
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
      ]),
      maxAttempts: 1,
    })
    expect(await client.fetchLatestAssistantText('ses_1')).toBeUndefined()
  })

  it('throws after exhausting retries on persistent 5xx', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = (async () => {
      calls += 1
      return new Response('{}', { status: 500 })
    }) as unknown as typeof fetch
    const client = createOpencodeClient({
      fetchImpl,
      maxAttempts: 3,
      sleepImpl: noopSleep,
    })
    await expect(client.fetchLatestAssistantText('ses_1')).rejects.toThrow(
      /HTTP 500/,
    )
    expect(calls).toBe(3)
  })

  it('retries transient failures and returns the assistant text on success', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = (async () => {
      calls += 1
      if (calls < 3) return new Response('{}', { status: 503 })
      return new Response(
        JSON.stringify([
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'OK' }],
          },
        ]),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const client = createOpencodeClient({
      fetchImpl,
      maxAttempts: 3,
      sleepImpl: noopSleep,
    })
    expect(await client.fetchLatestAssistantText('ses_1')).toBe('OK')
    expect(calls).toBe(3)
  })

  it('throws when the response payload is not an array', async () => {
    const client = createOpencodeClient({
      fetchImpl: buildFetch({ not: 'an array' }),
      maxAttempts: 1,
    })
    await expect(client.fetchLatestAssistantText('ses_1')).rejects.toThrow(
      /non-array payload/,
    )
  })

  it('finds a session id by exact title match', async () => {
    const client = createOpencodeClient({
      fetchImpl: buildFetch([
        { id: 'ses_other', title: 'other-task' },
        { id: 'ses_match', title: 'slack-17fed95f6e7c7d96' },
        { id: 'ses_dup', title: 'slack-17fed95f6e7c7d96' },
      ]),
      maxAttempts: 1,
    })
    expect(await client.findSessionIdByTitle('slack-17fed95f6e7c7d96')).toBe(
      'ses_match',
    )
  })

  it('returns undefined when no session matches the title', async () => {
    const client = createOpencodeClient({
      fetchImpl: buildFetch([{ id: 'ses_other', title: 'other-task' }]),
      maxAttempts: 1,
    })
    expect(await client.findSessionIdByTitle('slack-missing')).toBeUndefined()
  })

  it('retries transient failures on session listing', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = (async () => {
      calls += 1
      if (calls < 3) return new Response('{}', { status: 503 })
      return new Response(
        JSON.stringify([{ id: 'ses_x', title: 'slack-target' }]),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const client = createOpencodeClient({
      fetchImpl,
      maxAttempts: 3,
      sleepImpl: noopSleep,
    })
    expect(await client.findSessionIdByTitle('slack-target')).toBe('ses_x')
    expect(calls).toBe(3)
  })

  it('throws after exhausting retries on persistent 5xx for session lookup', async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response('{}', { status: 500 })) as unknown as typeof fetch
    const client = createOpencodeClient({
      fetchImpl,
      maxAttempts: 2,
      sleepImpl: noopSleep,
    })
    await expect(client.findSessionIdByTitle('slack-target')).rejects.toThrow(
      /HTTP 500/,
    )
  })

  it('records a success span and counters on fetchLatestAssistantText', async () => {
    const client = createOpencodeClient({
      baseUrl: 'http://opencode.test',
      fetchImpl: buildFetch([
        {
          info: { role: 'user' },
          parts: [{ type: 'text', text: 'hi' }],
        },
        {
          info: { role: 'assistant', modelID: 'opencode-go/claude-sonnet-4-6' },
          parts: [{ type: 'text', text: 'Hello world' }],
        },
      ]),
      maxAttempts: 1,
    })

    expect(await client.fetchLatestAssistantText('sess_abc')).toBe(
      'Hello world',
    )
    expect(captureSpy.mock.calls).toEqual([])
    expect(await collect()).toEqual({
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
    })
  })

  it('throws GoUsageLimitError, captures it, and records a rate_limited span on 429', async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response('{}', {
        status: 429,
        headers: { 'retry-after': '42' },
      })) as unknown as typeof fetch
    const client = createOpencodeClient({
      fetchImpl,
      maxAttempts: 3,
      sleepImpl: noopSleep,
    })

    const thrown = await client
      .fetchLatestAssistantText('sess_abc')
      .catch((e: unknown) => e)
    expect((thrown as Error).name).toBe('GoUsageLimitError')
    expect((thrown as { retryAfter?: number }).retryAfter).toBe(42)
    expect(
      captureSpy.mock.calls.map(([err, ctx]) => [(err as Error).name, ctx]),
    ).toEqual([['GoUsageLimitError', { retryAfter: 42 }]])
    expect(await collect()).toEqual({
      spans: [
        {
          name: 'opencode.message',
          attributes: {
            'opencode.session_id': 'sess_abc',
            'opencode.operation': 'fetch_messages',
            'opencode.model': 'unknown',
            'opencode.status': 'rate_limited',
            'http.status_code': 429,
            'http.retry_after': 42,
            'error.type': 'GoUsageLimitError',
          },
          statusCode: SpanStatusCode.ERROR,
        },
      ],
      messages: [],
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
    })
  })

  it('records an error span when retries are exhausted on 5xx', async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response('{}', { status: 500 })) as unknown as typeof fetch
    const client = createOpencodeClient({
      fetchImpl,
      maxAttempts: 2,
      sleepImpl: noopSleep,
    })

    const thrown = await client
      .fetchLatestAssistantText('sess_abc')
      .catch((e: unknown) => e)
    expect((thrown as Error).message).toBe(
      'opencode GET /session/sess_abc/message failed with HTTP 500',
    )
    expect(captureSpy.mock.calls).toEqual([])
    expect(await collect()).toEqual({
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
    })
  })

  it('records a single success span when a transient 5xx is retried into success', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = (async () => {
      calls += 1
      if (calls < 2) return new Response('{}', { status: 503 })
      return new Response(
        JSON.stringify([
          {
            info: {
              role: 'assistant',
              modelID: 'opencode-go/claude-sonnet-4-6',
            },
            parts: [{ type: 'text', text: 'OK' }],
          },
        ]),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const client = createOpencodeClient({
      fetchImpl,
      maxAttempts: 3,
      sleepImpl: noopSleep,
    })

    expect(await client.fetchLatestAssistantText('sess_abc')).toBe('OK')
    expect(calls).toBe(2)
    expect(captureSpy.mock.calls).toEqual([])
    expect(await collect()).toEqual({
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
    })
  })

  it('records a find_session success span with the placeholder session id', async () => {
    const client = createOpencodeClient({
      fetchImpl: buildFetch([{ id: 'ses_x', title: 'slack-target' }]),
      maxAttempts: 1,
    })

    expect(await client.findSessionIdByTitle('slack-target')).toBe('ses_x')
    expect(captureSpy.mock.calls).toEqual([])
    expect(await collect()).toEqual({
      spans: [
        {
          name: 'opencode.message',
          attributes: {
            'opencode.session_id': 'unknown',
            'opencode.operation': 'find_session',
            'opencode.model': 'unknown',
            'opencode.status': 'success',
            'opencode.assistant_count': 0,
            'http.status_code': 200,
          },
          statusCode: SpanStatusCode.UNSET,
        },
      ],
      messages: [],
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
    })
  })

  it('captures GoUsageLimitError and records a rate_limited find_session span on 429', async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response('{}', {
        status: 429,
        headers: { 'retry-after': '7' },
      })) as unknown as typeof fetch
    const client = createOpencodeClient({
      fetchImpl,
      maxAttempts: 3,
      sleepImpl: noopSleep,
    })

    const thrown = await client
      .findSessionIdByTitle('slack-target')
      .catch((e: unknown) => e)
    expect((thrown as Error).name).toBe('GoUsageLimitError')
    expect((thrown as { retryAfter?: number }).retryAfter).toBe(7)
    expect(
      captureSpy.mock.calls.map(([err, ctx]) => [(err as Error).name, ctx]),
    ).toEqual([['GoUsageLimitError', { retryAfter: 7 }]])
    expect(await collect()).toEqual({
      spans: [
        {
          name: 'opencode.message',
          attributes: {
            'opencode.session_id': 'unknown',
            'opencode.operation': 'find_session',
            'opencode.model': 'unknown',
            'opencode.status': 'rate_limited',
            'http.status_code': 429,
            'http.retry_after': 7,
            'error.type': 'GoUsageLimitError',
          },
          statusCode: SpanStatusCode.ERROR,
        },
      ],
      messages: [],
      calls: [
        {
          name: 'opencode.calls.count',
          attributes: {
            operation: 'find_session',
            status: 'rate_limited',
            http_status_code: 429,
          },
          value: 1,
        },
      ],
    })
  })
})
