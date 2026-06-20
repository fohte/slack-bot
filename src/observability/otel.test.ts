import type { ContextManager, TextMapPropagator } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import type { Sampler, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildResourceAttributes,
  createNodeSdk,
  createOtlpTraceExporter,
  isOtelConfigured,
} from '@/observability/otel'

const hoisted = vi.hoisted(() => {
  const autoInstrumentationSentinel = { __sentinel: 'auto-instrumentations' }
  return {
    autoInstrumentationSentinel,
    NodeSDKMock: vi.fn(),
    getNodeAutoInstrumentationsMock: vi.fn(() => [autoInstrumentationSentinel]),
  }
})

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: hoisted.NodeSDKMock,
}))

vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: hoisted.getNodeAutoInstrumentationsMock,
}))

describe('isOtelConfigured', () => {
  it('is true only when both endpoint and headers are present', () => {
    expect({
      bothPresent: isOtelConfigured({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example/',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic abc',
      }),
      endpointOnly: isOtelConfigured({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example/',
      }),
      headersOnly: isOtelConfigured({
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic abc',
      }),
      none: isOtelConfigured({}),
      emptyStrings: isOtelConfigured({
        OTEL_EXPORTER_OTLP_ENDPOINT: '   ',
        OTEL_EXPORTER_OTLP_HEADERS: '',
      }),
    }).toEqual({
      bothPresent: true,
      endpointOnly: false,
      headersOnly: false,
      none: false,
      emptyStrings: false,
    })
  })
})

describe('buildResourceAttributes', () => {
  it('defaults service.name to slack-bot when env is empty', () => {
    expect(buildResourceAttributes({})).toEqual({ 'service.name': 'slack-bot' })
  })

  it('takes service.name from OTEL_SERVICE_NAME when set', () => {
    expect(
      buildResourceAttributes({ OTEL_SERVICE_NAME: 'custom-service' }),
    ).toEqual({ 'service.name': 'custom-service' })
  })

  it('parses OTEL_RESOURCE_ATTRIBUTES and falls back to the default service name', () => {
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
        OTEL_RESOURCE_ATTRIBUTES:
          'service.name=ignored,deployment.environment=production',
      }),
    ).toEqual({
      'service.name': 'override-service',
      'deployment.environment': 'production',
    })
  })

  it('uses service.name from OTEL_RESOURCE_ATTRIBUTES when OTEL_SERVICE_NAME is unset', () => {
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

  it('drops entries with empty key or value', () => {
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

describe('createOtlpTraceExporter', () => {
  it('builds an OTLPTraceExporter instance', () => {
    expect(
      createOtlpTraceExporter({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example/',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic abc',
      }),
    ).toBeInstanceOf(OTLPTraceExporter)
  })
})

describe('createNodeSdk', () => {
  beforeEach(() => {
    hoisted.NodeSDKMock.mockClear()
    hoisted.getNodeAutoInstrumentationsMock.mockClear()
  })

  it('wires resource, OTLP exporter, auto-instrumentations and pass-through overrides', () => {
    const sampler = { __kind: 'sampler' } as unknown as Sampler
    const spanProcessor = {
      __kind: 'span-processor',
    } as unknown as SpanProcessor
    const propagator = { __kind: 'propagator' } as unknown as TextMapPropagator
    const contextManager = {
      __kind: 'context-manager',
    } as unknown as ContextManager

    createNodeSdk({
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example/',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic abc',
        OTEL_SERVICE_NAME: 'slack-bot',
        OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=production',
      },
      sampler,
      spanProcessors: [spanProcessor],
      propagator,
      contextManager,
    })

    const config = hoisted.NodeSDKMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >
    const resource = config['resource'] as {
      attributes: Record<string, unknown>
    }

    expect({
      traceExporterIsOtlp: config['traceExporter'] instanceof OTLPTraceExporter,
      resourceAttributes: resource.attributes,
      instrumentations: config['instrumentations'],
      sampler: config['sampler'],
      spanProcessors: config['spanProcessors'],
      textMapPropagator: config['textMapPropagator'],
      contextManager: config['contextManager'],
      autoInstrumentationsCalled:
        hoisted.getNodeAutoInstrumentationsMock.mock.calls.length,
    }).toEqual({
      traceExporterIsOtlp: true,
      resourceAttributes: {
        'deployment.environment': 'production',
        'service.name': 'slack-bot',
      },
      instrumentations: [hoisted.autoInstrumentationSentinel],
      sampler,
      spanProcessors: [spanProcessor],
      textMapPropagator: propagator,
      contextManager,
      autoInstrumentationsCalled: 1,
    })
  })

  it('omits override fields when not provided', () => {
    createNodeSdk({
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example/',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic abc',
      },
    })

    const config = hoisted.NodeSDKMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >
    expect({
      hasSampler: 'sampler' in config,
      hasSpanProcessors: 'spanProcessors' in config,
      hasTextMapPropagator: 'textMapPropagator' in config,
      hasContextManager: 'contextManager' in config,
    }).toEqual({
      hasSampler: false,
      hasSpanProcessors: false,
      hasTextMapPropagator: false,
      hasContextManager: false,
    })
  })
})
