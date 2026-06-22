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

  let sentryStarted = false
  let otelSdk: ReturnType<typeof createNodeSdk> | undefined

  try {
    if (sentry) {
      initSentry(env)
      sentryStarted = true
    }

    // Hand OTel the Sentry propagator and context manager so Sentry's
    // autocapture inherits the trace_id from the active OTel span.
    otelSdk = otel
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

    // Registering a custom listener for SIGTERM/SIGINT suppresses Node's
    // default termination, so re-send the signal after shutdown completes —
    // the `once` listener has already removed itself, so the second delivery
    // triggers the default behavior.
    const onSignal = (signal: NodeJS.Signals): void => {
      void shutdown().then(() => {
        process.kill(process.pid, signal)
      })
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
    void Promise.allSettled([
      otelSdk ? otelSdk.shutdown() : Promise.resolve(),
      sentryStarted ? Sentry.close() : Promise.resolve(),
    ])
    return noopHandle
  }
}
