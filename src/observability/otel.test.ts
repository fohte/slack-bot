import { trace } from '@opentelemetry/api'
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { OtelOptions } from '@/observability/otel'
import {
  buildResourceAttributes,
  createNodeSdk,
  isOtelConfigured,
} from '@/observability/otel'

describe('isOtelConfigured', () => {
  it('returns true when the endpoint is set', () => {
    expect(
      isOtelConfigured({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example/',
      }),
    ).toBe(true)
  })

  it('returns false when the endpoint is missing', () => {
    expect(isOtelConfigured({})).toBe(false)
  })

  it('returns false when the endpoint is blank', () => {
    expect(isOtelConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: '   ' })).toBe(false)
  })

  it('ignores OTEL_EXPORTER_OTLP_HEADERS when deciding configuration', () => {
    expect(
      isOtelConfigured({
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic abc',
      }),
    ).toBe(false)
  })
})

describe('buildResourceAttributes', () => {
  it('defaults service.name to slack-bot when no env is set', () => {
    expect(buildResourceAttributes({})).toEqual({ 'service.name': 'slack-bot' })
  })

  it('takes service.name from OTEL_SERVICE_NAME', () => {
    expect(
      buildResourceAttributes({ OTEL_SERVICE_NAME: 'custom-service' }),
    ).toEqual({ 'service.name': 'custom-service' })
  })

  it('parses OTEL_RESOURCE_ATTRIBUTES into individual attributes', () => {
    expect(
      buildResourceAttributes({
        OTEL_RESOURCE_ATTRIBUTES:
          'deployment.environment=production,service.version=1.2.3',
      }),
    ).toEqual({
      'deployment.environment': 'production',
      'service.version': '1.2.3',
      'service.name': 'slack-bot',
    })
  })

  it('lets OTEL_SERVICE_NAME override service.name from OTEL_RESOURCE_ATTRIBUTES', () => {
    expect(
      buildResourceAttributes({
        OTEL_SERVICE_NAME: 'override-service',
        OTEL_RESOURCE_ATTRIBUTES: 'service.name=ignored',
      }),
    ).toEqual({ 'service.name': 'override-service' })
  })

  it('falls back to service.name from OTEL_RESOURCE_ATTRIBUTES when OTEL_SERVICE_NAME is unset', () => {
    expect(
      buildResourceAttributes({
        OTEL_RESOURCE_ATTRIBUTES: 'service.name=from-attrs',
      }),
    ).toEqual({ 'service.name': 'from-attrs' })
  })

  it('percent-decodes both keys and values', () => {
    expect(
      buildResourceAttributes({
        OTEL_RESOURCE_ATTRIBUTES: 'k%2Fey=v%20alue',
      }),
    ).toEqual({ 'k/ey': 'v alue', 'service.name': 'slack-bot' })
  })

  it('drops entries with an empty key or value', () => {
    expect(
      buildResourceAttributes({
        OTEL_RESOURCE_ATTRIBUTES: 'foo=,=bar,deployment.environment=production',
      }),
    ).toEqual({
      'deployment.environment': 'production',
      'service.name': 'slack-bot',
    })
  })
})

describe('createNodeSdk', () => {
  const sdks: { shutdown: () => Promise<void> }[] = []

  const savedEnv: Record<string, string | undefined> = {}
  const setTestEnv = (key: string, value: string): void => {
    savedEnv[key] = process.env[key]
    process.env[key] = value
  }

  beforeEach(() => {
    // Restrict to the synchronous env detector so spans emitted in tests
    // aren't held back by host.id resolution from the default host detector.
    setTestEnv('OTEL_NODE_RESOURCE_DETECTORS', 'env')
    // Keep shutdown fast even though the OTLP exporter can't reach the
    // unreachable test endpoint.
    setTestEnv('OTEL_BSP_EXPORT_TIMEOUT', '1')
    setTestEnv('OTEL_BSP_SCHEDULE_DELAY', '1')
  })

  afterEach(async () => {
    while (sdks.length > 0) {
      const sdk = sdks.pop()
      await sdk?.shutdown().catch(() => {})
    }
    trace.disable()
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key)
      } else {
        process.env[key] = value
      }
    }
  })

  const startSdkWithRecorder = (
    options: Omit<OtelOptions, 'spanProcessors'>,
  ): InMemorySpanExporter => {
    const exporter = new InMemorySpanExporter()
    const sdk = createNodeSdk({
      ...options,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    sdk.start()
    sdks.push(sdk)
    return exporter
  }

  it('exports spans with the resource attributes built from env', () => {
    const exporter = startSdkWithRecorder({
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318/v1/traces',
        OTEL_SERVICE_NAME: 'slack-bot',
        OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=test',
      },
    })

    trace.getTracer('test').startSpan('demo').end()

    const span = exporter.getFinishedSpans()[0]
    expect({
      spanNames: exporter.getFinishedSpans().map((s) => s.name),
      serviceName: span?.resource.attributes['service.name'],
      deploymentEnvironment:
        span?.resource.attributes['deployment.environment'],
    }).toEqual({
      spanNames: ['demo'],
      serviceName: 'slack-bot',
      deploymentEnvironment: 'test',
    })
  })
})
