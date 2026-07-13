import type { Attributes } from '@opentelemetry/api'
import { metrics } from '@opentelemetry/api'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as A2aCounters from '@/observability/a2a-counters'

// Counters lazily cache the OTel instruments on first use. Each test resets
// modules and re-imports so the lazy cache picks up the test-local provider
// instead of a stale (or noop) instrument from a prior test.
let recordA2aTaskSettled: typeof A2aCounters.recordA2aTaskSettled
let recordA2aPushNotification: typeof A2aCounters.recordA2aPushNotification

const importCounters = async (): Promise<void> => {
  vi.resetModules()
  const mod = await import('@/observability/a2a-counters')
  recordA2aTaskSettled = mod.recordA2aTaskSettled
  recordA2aPushNotification = mod.recordA2aPushNotification
}

interface MetricRow {
  readonly name: string
  readonly attributes: Attributes
  readonly value: number
}

let metricExporter: InMemoryMetricExporter
let meterProvider: MeterProvider

const setupObservability = (): void => {
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
  await meterProvider.shutdown()
  metrics.disable()
}

const collect = async (): Promise<readonly MetricRow[]> => {
  await meterProvider.forceFlush()
  const rows: MetricRow[] = []
  for (const rm of metricExporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        for (const p of m.dataPoints) {
          rows.push({
            name: m.descriptor.name,
            attributes: p.attributes,
            value: p.value as number,
          })
        }
      }
    }
  }
  return rows
}

describe('recordA2aTaskSettled', () => {
  beforeEach(async () => {
    setupObservability()
    await importCounters()
  })
  afterEach(async () => {
    await teardownObservability()
  })

  it('increments llm_agent.a2a.tasks.count with agent and outcome attributes', async () => {
    recordA2aTaskSettled('meshi', 'completed')

    expect(await collect()).toEqual([
      {
        name: 'llm_agent.a2a.tasks.count',
        attributes: { agent: 'meshi', outcome: 'completed' },
        value: 1,
      },
    ])
  })

  it('increments the same data point on repeated calls with identical attributes', async () => {
    recordA2aTaskSettled('meshi', 'completed')
    recordA2aTaskSettled('meshi', 'completed')

    expect(await collect()).toEqual([
      {
        name: 'llm_agent.a2a.tasks.count',
        attributes: { agent: 'meshi', outcome: 'completed' },
        value: 2,
      },
    ])
  })

  it('accumulates separate data points per agent/outcome pair', async () => {
    recordA2aTaskSettled('meshi', 'completed')
    recordA2aTaskSettled('t-rader', 'failed')

    // OTel does not guarantee data point ordering across distinct attribute
    // sets on the same instrument, so this sorts before the single equality
    // check rather than depending on export order.
    const sorted = [...(await collect())].sort((a, b) =>
      String(a.attributes['agent']).localeCompare(
        String(b.attributes['agent']),
      ),
    )
    expect(sorted).toEqual([
      {
        name: 'llm_agent.a2a.tasks.count',
        attributes: { agent: 'meshi', outcome: 'completed' },
        value: 1,
      },
      {
        name: 'llm_agent.a2a.tasks.count',
        attributes: { agent: 't-rader', outcome: 'failed' },
        value: 1,
      },
    ])
  })
})

describe('recordA2aPushNotification', () => {
  beforeEach(async () => {
    setupObservability()
    await importCounters()
  })
  afterEach(async () => {
    await teardownObservability()
  })

  it('increments llm_agent.a2a.push_notifications.count with a result attribute', async () => {
    recordA2aPushNotification('settled')

    expect(await collect()).toEqual([
      {
        name: 'llm_agent.a2a.push_notifications.count',
        attributes: { result: 'settled' },
        value: 1,
      },
    ])
  })

  it('accumulates separate data points per result', async () => {
    recordA2aPushNotification('settled')
    recordA2aPushNotification('unauthorized')

    const sorted = [...(await collect())].sort((a, b) =>
      String(a.attributes['result']).localeCompare(
        String(b.attributes['result']),
      ),
    )
    expect(sorted).toEqual([
      {
        name: 'llm_agent.a2a.push_notifications.count',
        attributes: { result: 'settled' },
        value: 1,
      },
      {
        name: 'llm_agent.a2a.push_notifications.count',
        attributes: { result: 'unauthorized' },
        value: 1,
      },
    ])
  })
})

describe('a2a-counters without observability initialized', () => {
  beforeEach(async () => {
    metrics.disable()
    await importCounters()
  })

  it('runs as a no-op and does not throw', () => {
    expect(() => {
      recordA2aTaskSettled('meshi', 'completed')
      recordA2aPushNotification('settled')
    }).not.toThrow()
  })
})
