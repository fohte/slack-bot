import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Captured {
  initSentryCalls: unknown[]
  createNodeSdkCalls: unknown[]
  sdkStartCount: number
  sdkShutdownCount: number
  sentryCloseCount: number
  loggerInfoCalls: unknown[]
  loggerWarnCalls: unknown[]
  signalHandlers: Record<string, Array<() => void>>
}

const captured: Captured = {
  initSentryCalls: [],
  createNodeSdkCalls: [],
  sdkStartCount: 0,
  sdkShutdownCount: 0,
  sentryCloseCount: 0,
  loggerInfoCalls: [],
  loggerWarnCalls: [],
  signalHandlers: {},
}

const sdkInstance = {
  start: () => {
    captured.sdkStartCount += 1
  },
  shutdown: async () => {
    captured.sdkShutdownCount += 1
  },
}

vi.mock('@/observability/otel', () => ({
  isOtelConfigured: (env: { OTEL_EXPORTER_OTLP_ENDPOINT?: string }) =>
    typeof env.OTEL_EXPORTER_OTLP_ENDPOINT === 'string' &&
    env.OTEL_EXPORTER_OTLP_ENDPOINT.length > 0,
  createNodeSdk: (options: unknown) => {
    captured.createNodeSdkCalls.push(options)
    return sdkInstance
  },
}))

vi.mock('@/observability/sentry', () => ({
  isSentryConfigured: (env: { SENTRY_DSN?: string }) =>
    typeof env.SENTRY_DSN === 'string' && env.SENTRY_DSN.length > 0,
  initSentry: (env: unknown) => {
    captured.initSentryCalls.push(env)
    return { client: true }
  },
}))

class FakeSentryContextManager {
  enable(): this {
    return this
  }
}
class FakeSentryPropagator {
  fields(): string[] {
    return []
  }
}

vi.mock('@sentry/node', () => ({
  SentryContextManager: FakeSentryContextManager,
  close: async () => {
    captured.sentryCloseCount += 1
    return true
  },
}))

vi.mock('@sentry/opentelemetry', () => ({
  SentryPropagator: FakeSentryPropagator,
}))

const loggerSpy = {
  info: (fields: unknown, message?: string) => {
    captured.loggerInfoCalls.push({ fields, message })
  },
  warn: (fields: unknown, message?: string) => {
    captured.loggerWarnCalls.push({ fields, message })
  },
  debug: () => {},
  error: () => {},
  child: () => loggerSpy,
}

vi.mock('@/logger/logger', () => ({
  createLogger: () => loggerSpy,
}))

const { initObservability } = await import('@/observability/init')

const resetCaptured = (): void => {
  captured.initSentryCalls = []
  captured.createNodeSdkCalls = []
  captured.sdkStartCount = 0
  captured.sdkShutdownCount = 0
  captured.sentryCloseCount = 0
  captured.loggerInfoCalls = []
  captured.loggerWarnCalls = []
  captured.signalHandlers = {}
}

const stubProcessOnce = (): void => {
  vi.spyOn(process, 'once').mockImplementation(((
    event: string | symbol,
    listener: (...args: unknown[]) => void,
  ) => {
    const key = String(event)
    captured.signalHandlers[key] ??= []
    captured.signalHandlers[key].push(listener as () => void)
    return process
  }) as typeof process.once)
}

beforeEach(() => {
  resetCaptured()
  stubProcessOnce()
})

describe('initObservability', () => {
  it('initializes both Sentry and OTel when configured', async () => {
    const handle = initObservability({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example/',
      SENTRY_DSN: 'https://x@y/1',
    })
    await handle.shutdown()

    expect({
      initSentryCount: captured.initSentryCalls.length,
      createNodeSdkCount: captured.createNodeSdkCalls.length,
      sdkHasPropagator:
        captured.createNodeSdkCalls[0] !== undefined &&
        (captured.createNodeSdkCalls[0] as { propagator?: unknown })
          .propagator !== undefined,
      sdkHasContextManager:
        captured.createNodeSdkCalls[0] !== undefined &&
        (captured.createNodeSdkCalls[0] as { contextManager?: unknown })
          .contextManager !== undefined,
      sdkStartCount: captured.sdkStartCount,
      sdkShutdownCount: captured.sdkShutdownCount,
      sentryCloseCount: captured.sentryCloseCount,
      loggerInfoCalls: captured.loggerInfoCalls,
      loggerWarnCalls: captured.loggerWarnCalls,
      signalsRegistered: Object.keys(captured.signalHandlers).sort(),
    }).toEqual({
      initSentryCount: 1,
      createNodeSdkCount: 1,
      sdkHasPropagator: true,
      sdkHasContextManager: true,
      sdkStartCount: 1,
      sdkShutdownCount: 1,
      sentryCloseCount: 1,
      loggerInfoCalls: [
        {
          fields: {
            event: 'observability_initialized',
            otel: true,
            sentry: true,
          },
          message: 'observability initialized',
        },
      ],
      loggerWarnCalls: [],
      signalsRegistered: ['SIGINT', 'SIGTERM'],
    })
  })

  it('initializes Sentry alone when OTel endpoint is missing', async () => {
    const handle = initObservability({ SENTRY_DSN: 'https://x@y/1' })
    await handle.shutdown()

    expect({
      initSentryCount: captured.initSentryCalls.length,
      createNodeSdkCount: captured.createNodeSdkCalls.length,
      sdkStartCount: captured.sdkStartCount,
      sdkShutdownCount: captured.sdkShutdownCount,
      sentryCloseCount: captured.sentryCloseCount,
      loggerInfoCalls: captured.loggerInfoCalls,
      loggerWarnCalls: captured.loggerWarnCalls,
      signalsRegistered: Object.keys(captured.signalHandlers).sort(),
    }).toEqual({
      initSentryCount: 1,
      createNodeSdkCount: 0,
      sdkStartCount: 0,
      sdkShutdownCount: 0,
      sentryCloseCount: 1,
      loggerInfoCalls: [
        {
          fields: {
            event: 'observability_initialized',
            otel: false,
            sentry: true,
          },
          message: 'observability initialized',
        },
      ],
      loggerWarnCalls: [],
      signalsRegistered: ['SIGINT', 'SIGTERM'],
    })
  })

  it('initializes OTel alone without SentryPropagator/SentryContextManager when DSN is missing', async () => {
    const handle = initObservability({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example/',
    })
    await handle.shutdown()

    expect({
      initSentryCount: captured.initSentryCalls.length,
      createNodeSdkCount: captured.createNodeSdkCalls.length,
      sdkHasPropagator:
        captured.createNodeSdkCalls[0] !== undefined &&
        (captured.createNodeSdkCalls[0] as { propagator?: unknown })
          .propagator !== undefined,
      sdkHasContextManager:
        captured.createNodeSdkCalls[0] !== undefined &&
        (captured.createNodeSdkCalls[0] as { contextManager?: unknown })
          .contextManager !== undefined,
      sdkStartCount: captured.sdkStartCount,
      sdkShutdownCount: captured.sdkShutdownCount,
      sentryCloseCount: captured.sentryCloseCount,
      loggerInfoCalls: captured.loggerInfoCalls,
      loggerWarnCalls: captured.loggerWarnCalls,
      signalsRegistered: Object.keys(captured.signalHandlers).sort(),
    }).toEqual({
      initSentryCount: 0,
      createNodeSdkCount: 1,
      sdkHasPropagator: false,
      sdkHasContextManager: false,
      sdkStartCount: 1,
      sdkShutdownCount: 1,
      sentryCloseCount: 0,
      loggerInfoCalls: [
        {
          fields: {
            event: 'observability_initialized',
            otel: true,
            sentry: false,
          },
          message: 'observability initialized',
        },
      ],
      loggerWarnCalls: [],
      signalsRegistered: ['SIGINT', 'SIGTERM'],
    })
  })

  it('returns a no-op handle when neither SDK is configured', async () => {
    const handle = initObservability({})
    await handle.shutdown()

    expect({
      initSentryCount: captured.initSentryCalls.length,
      createNodeSdkCount: captured.createNodeSdkCalls.length,
      sdkStartCount: captured.sdkStartCount,
      sdkShutdownCount: captured.sdkShutdownCount,
      sentryCloseCount: captured.sentryCloseCount,
      loggerInfoCalls: captured.loggerInfoCalls,
      loggerWarnCalls: captured.loggerWarnCalls,
      signalsRegistered: Object.keys(captured.signalHandlers).sort(),
    }).toEqual({
      initSentryCount: 0,
      createNodeSdkCount: 0,
      sdkStartCount: 0,
      sdkShutdownCount: 0,
      sentryCloseCount: 0,
      loggerInfoCalls: [
        {
          fields: {
            event: 'observability_initialized',
            otel: false,
            sentry: false,
          },
          message: 'observability initialized',
        },
      ],
      loggerWarnCalls: [],
      signalsRegistered: [],
    })
  })

  it('runs SDK shutdown and Sentry close at most once across repeated calls', async () => {
    const handle = initObservability({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example/',
      SENTRY_DSN: 'https://x@y/1',
    })
    await handle.shutdown()
    await handle.shutdown()
    await handle.shutdown()

    expect({
      sdkShutdownCount: captured.sdkShutdownCount,
      sentryCloseCount: captured.sentryCloseCount,
    }).toEqual({
      sdkShutdownCount: 1,
      sentryCloseCount: 1,
    })
  })
})
