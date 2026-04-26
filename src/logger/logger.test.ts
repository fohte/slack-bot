import { Writable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { createLogger } from '@/logger/logger'

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
  const lines = (): Record<string, unknown>[] => {
    const text = Buffer.concat(chunks).toString('utf8')
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }
  return { stream, lines }
}

describe('createLogger', () => {
  it('emits structured JSON logs', () => {
    const { stream, lines } = collect()
    const logger = createLogger({ level: 'info', destination: stream })
    logger.info({ event: 'hello', endpoint: 'commands' }, 'message text')
    const entry = lines()[0]
    expect(entry).toBeDefined()
    expect(entry?.['event']).toBe('hello')
    expect(entry?.['endpoint']).toBe('commands')
    expect(entry?.['level']).toBe('info')
    expect(entry?.['msg']).toBe('message text')
  })

  it('redacts known secret keys', () => {
    const { stream, lines } = collect()
    const logger = createLogger({ level: 'info', destination: stream })
    logger.info({
      event: 'leak',
      slack_bot_token: 'xoxb-leaked',
      authorization: 'Bearer leaked',
      nested: { token: 'inner-secret' },
    })
    const entry = lines()[0]
    expect(entry?.['slack_bot_token']).toBe('[REDACTED]')
    expect(entry?.['authorization']).toBe('[REDACTED]')
    const nested = entry?.['nested'] as Record<string, unknown>
    expect(nested['token']).toBe('[REDACTED]')
  })

  it('respects log level filtering', () => {
    const { stream, lines } = collect()
    const logger = createLogger({ level: 'warn', destination: stream })
    logger.info({ event: 'skipped' })
    logger.warn({ event: 'kept' })
    expect(lines()).toHaveLength(1)
    expect(lines()[0]?.['event']).toBe('kept')
  })

  it('child logger inherits bindings', () => {
    const { stream, lines } = collect()
    const logger = createLogger({ level: 'info', destination: stream })
    const child = logger.child({ component: 'router' })
    child.info({ event: 'dispatch' })
    expect(lines()[0]?.['component']).toBe('router')
  })
})
