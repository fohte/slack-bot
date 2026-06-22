import * as Sentry from '@sentry/node'
import { SentryPropagator } from '@sentry/opentelemetry'

import { createLogger, type Logger } from '@/logger/logger'
import {
  createNodeSdk,
  isOtelConfigured,
  type ObservabilityEnv as OtelEnv,
} from '@/observability/otel'
import {
  initSentry,
  isSentryConfigured,
  type ObservabilityEnv as SentryEnv,
} from '@/observability/sentry'

export interface ObservabilityEnv extends OtelEnv, SentryEnv {}

export interface ObservabilityHandle {
  readonly shutdown: () => Promise<void>
}

const noopHandle: ObservabilityHandle = { shutdown: async () => {} }

const buildLogger = (): Logger =>
  createLogger({ level: 'info', base: { service: 'slack-bot' } })

export const initObservability = (
  env: ObservabilityEnv,
): ObservabilityHandle => {
  const logger = buildLogger()
  const otel = isOtelConfigured(env)
  const sentry = isSentryConfigured(env)

  try {
    let sentryStarted = false
    if (sentry) {
      initSentry(env)
      sentryStarted = true
    }

    // Sentry needs to know about the active OTel span to attach the same
    // trace_id to its error events; we share the propagator and context
    // manager only when both SDKs are active.
    const otelSdk = otel
      ? createNodeSdk({
          env,
          ...(sentry
            ? {
                propagator: new SentryPropagator(),
                contextManager: new Sentry.SentryContextManager(),
              }
            : {}),
        })
      : undefined
    otelSdk?.start()

    if (otel && sentry) {
      Sentry.validateOpenTelemetrySetup()
    }

    logger.info(
      { event: 'observability_initialized', otel, sentry },
      'observability initialized',
    )

    if (!sentryStarted && otelSdk === undefined) {
      return noopHandle
    }

    let shutdownPromise: Promise<void> | undefined
    const shutdown = (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise
      shutdownPromise = Promise.allSettled([
        otelSdk ? otelSdk.shutdown() : Promise.resolve(),
        sentryStarted ? Sentry.close() : Promise.resolve(),
      ]).then(() => undefined)
      return shutdownPromise
    }

    const onSignal = (): void => {
      void shutdown()
    }
    process.once('SIGTERM', onSignal)
    process.once('SIGINT', onSignal)

    return { shutdown }
  } catch (err) {
    logger.warn(
      {
        event: 'observability_init_failed',
        error: err instanceof Error ? err.message : String(err),
      },
      'failed to initialize observability',
    )
    return noopHandle
  }
}
