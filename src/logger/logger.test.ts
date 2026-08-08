import { Writable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { createLogger } from '#logger/logger'

const collect = (): {
  stream: Writable
  lines: () => Record<string, unknown>[]
} => {
  const chunks: Buffer[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk as Uint8Array))
      callback()
    },
  })
  const lines = (): Record<string, unknown>[] =>
    Buffer.concat(chunks)
      .toString('utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  return { stream, lines }
}

const normalizeTime = (
  record: Record<string, unknown>,
): Record<string, unknown> => ({ ...record, time: 'TIME' })

// createLogger() is a thin wrapper around @fohte/service-kit/logger, whose
// own test suite already covers level filtering, base merging, pretty
// transport, and default redaction. Only this wrapper's own behavior
// (extending the default redact patterns) is tested here.
describe('createLogger', () => {
  it("redacts this repo's `_secret`-suffixed keys in addition to service-kit's defaults", () => {
    const { stream, lines } = collect()
    const logger = createLogger({ level: 'info', destination: stream })

    logger.info(
      {
        slack_bot_token: 'xoxb-leaked',
        signing_secret: 'sss',
        cf_access_client_secret: 'cfs',
        nested: { service_token_secret: 'nested-secret' },
      },
      'redacted',
    )

    expect(lines().map(normalizeTime)).toEqual([
      {
        level: 30,
        time: 'TIME',
        slack_bot_token: '[REDACTED]',
        signing_secret: '[REDACTED]',
        cf_access_client_secret: '[REDACTED]',
        nested: { service_token_secret: '[REDACTED]' },
        msg: 'redacted',
      },
    ])
  })

  it('combines a caller-supplied extraSecretKeyPatterns with its own default instead of replacing it', () => {
    const { stream, lines } = collect()
    const logger = createLogger({
      level: 'info',
      destination: stream,
      extraSecretKeyPatterns: [/^custom$/i],
    })

    logger.info({ signing_secret: 'sss', custom: 'leaked' }, 'redacted')

    expect(lines().map(normalizeTime)).toEqual([
      {
        level: 30,
        time: 'TIME',
        signing_secret: '[REDACTED]',
        custom: '[REDACTED]',
        msg: 'redacted',
      },
    ])
  })
})
