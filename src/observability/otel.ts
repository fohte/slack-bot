import type { ContextManager, TextMapPropagator } from '@opentelemetry/api'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import type { Resource } from '@opentelemetry/resources'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { NodeSDK } from '@opentelemetry/sdk-node'
import type { Sampler, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'

export const DEFAULT_SERVICE_NAME = 'slack-bot'

export interface ObservabilityEnv {
  readonly OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined
  readonly OTEL_EXPORTER_OTLP_HEADERS?: string | undefined
  readonly OTEL_SERVICE_NAME?: string | undefined
  readonly OTEL_RESOURCE_ATTRIBUTES?: string | undefined
}

export interface OtelOptions {
  readonly env: ObservabilityEnv
  readonly sampler?: Sampler | undefined
  readonly spanProcessors?: readonly SpanProcessor[] | undefined
  readonly propagator?: TextMapPropagator | undefined
  readonly contextManager?: ContextManager | undefined
}

export const isOtelConfigured = (env: ObservabilityEnv): boolean => {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ?? ''
  return endpoint.length > 0
}

// Parses OTEL_RESOURCE_ATTRIBUTES / OTEL_EXPORTER_OTLP_HEADERS format
// (`key1=value1,key2=value2`). Both keys and values are percent-decoded per
// the OTel spec's W3C Baggage encoding. Entries with an empty key or value
// are dropped so callers don't accidentally emit blank resource attributes
// or auth headers.
const safeDecode = (raw: string): string => {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

const parseKeyValueList = (raw: string | undefined): Record<string, string> => {
  if (raw === undefined || raw.length === 0) return {}
  const out: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const key = safeDecode(pair.slice(0, eq).trim())
    const value = safeDecode(pair.slice(eq + 1).trim())
    if (key.length === 0 || value.length === 0) continue
    out[key] = value
  }
  return out
}

export const buildResourceAttributes = (
  env: ObservabilityEnv,
): Record<string, string> => {
  const extra = parseKeyValueList(env.OTEL_RESOURCE_ATTRIBUTES)
  const explicit = env.OTEL_SERVICE_NAME?.trim() ?? ''
  const fromAttrs = extra[ATTR_SERVICE_NAME] ?? ''
  const serviceName =
    explicit.length > 0
      ? explicit
      : fromAttrs.length > 0
        ? fromAttrs
        : DEFAULT_SERVICE_NAME
  return { ...extra, [ATTR_SERVICE_NAME]: serviceName }
}

export const buildResource = (env: ObservabilityEnv): Resource =>
  resourceFromAttributes(buildResourceAttributes(env))

export const createOtlpTraceExporter = (
  env: ObservabilityEnv,
): OTLPTraceExporter => {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ?? ''
  const headers = parseKeyValueList(env.OTEL_EXPORTER_OTLP_HEADERS)
  return new OTLPTraceExporter({
    ...(endpoint.length > 0 ? { url: endpoint } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  })
}

export const createNodeSdk = (options: OtelOptions): NodeSDK => {
  const { env, sampler, spanProcessors, propagator, contextManager } = options
  const traceExporter = createOtlpTraceExporter(env)
  const resource = buildResource(env)
  const instrumentations = getNodeAutoInstrumentations()
  // Supplying `spanProcessors` to NodeSDK replaces the default
  // BatchSpanProcessor(traceExporter) instead of appending to it, so prepend
  // it manually whenever the caller wires in extra processors (e.g. Sentry).
  const hasExtraProcessors =
    spanProcessors !== undefined && spanProcessors.length > 0
  const mergedSpanProcessors = hasExtraProcessors
    ? [new BatchSpanProcessor(traceExporter), ...spanProcessors]
    : undefined
  return new NodeSDK({
    resource,
    traceExporter,
    instrumentations,
    ...(sampler ? { sampler } : {}),
    ...(mergedSpanProcessors ? { spanProcessors: mergedSpanProcessors } : {}),
    ...(propagator ? { textMapPropagator: propagator } : {}),
    ...(contextManager ? { contextManager } : {}),
  })
}
