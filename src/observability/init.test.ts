import { beforeEach, describe, expect, it, vi } from 'vitest'

interface CapturedInitCall {
  env: unknown
  options: Record<string, unknown>
}

const captured: { calls: CapturedInitCall[] } = { calls: [] }

vi.mock('@fohte/service-kit/observability', () => ({
  initObservability: (
    env: unknown,
    options: Record<string, unknown>,
  ): { shutdown: () => Promise<void> } => {
    captured.calls.push({ env, options })
    return { shutdown: async () => {} }
  },
}))

const { initObservability } = await import('@/observability/init')

beforeEach(() => {
  captured.calls = []
})

const normalize = (calls: CapturedInitCall[]): CapturedInitCall[] =>
  calls.map((call) => ({
    env: call.env,
    options: { ...call.options, logger: '<logger>' },
  }))

describe('initObservability (slack-bot wrapper)', () => {
  it('forwards env and slack-bot specific options to the library', () => {
    const env = { SENTRY_DSN: 'https://x@y/1', OTEL_EXPORTER_OTLP_ENDPOINT: '' }
    initObservability(env)

    expect(normalize(captured.calls)).toEqual([
      {
        env,
        options: {
          extraStringTruncators: [
            { pattern: /^(slack_)?message(_text|_body)?$/i, maxLength: 200 },
          ],
          logger: '<logger>',
        },
      },
    ])
  })
})
