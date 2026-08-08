import { afterEach, describe, expect, it } from 'vitest'

import { noopLogger } from '#logger/logger'
import { createDeferred } from '#server/_test-utils'
import { createShutdownHandler } from '#server/shutdown'

afterEach(() => {
  process.removeAllListeners('SIGTERM')
  process.removeAllListeners('SIGINT')
})

describe('createShutdownHandler', () => {
  it('drains in-flight tasks, closes the server, then exits', async () => {
    const timeline: string[] = []
    const idle = createDeferred<undefined>()
    const handle = createShutdownHandler({
      server: {
        close: (callback) => {
          timeline.push('server-closed')
          callback?.()
        },
      },
      inFlightTasks: {
        waitForIdle: async () => {
          await idle.promise
          timeline.push('drained')
        },
      },
      logger: noopLogger,
      exit: (code) => {
        timeline.push(`exited:${code}`)
      },
    })
    const result = handle.shutdown('SIGTERM')
    idle.resolve(undefined)
    await result
    expect(timeline).toEqual(['drained', 'server-closed', 'exited:0'])
  })

  it('ignores a second signal received while already shutting down', async () => {
    let closeCalls = 0
    const idle = createDeferred<undefined>()
    const handle = createShutdownHandler({
      server: {
        close: (callback) => {
          closeCalls += 1
          callback?.()
        },
      },
      inFlightTasks: { waitForIdle: () => idle.promise },
      logger: noopLogger,
      exit: () => {},
    })
    const first = handle.shutdown('SIGTERM')
    const second = handle.shutdown('SIGTERM')
    idle.resolve(undefined)
    await Promise.all([first, second])
    expect(closeCalls).toBe(1)
  })

  it('logs and still exits when server.close reports an error', async () => {
    const warnCalls: Array<{
      payload: Record<string, unknown>
      message: string
    }> = []
    const timeline: string[] = []
    const closeError = new Error('already closed')
    const handle = createShutdownHandler({
      server: {
        close: (callback) => {
          callback?.(closeError)
        },
      },
      inFlightTasks: { waitForIdle: async () => {} },
      logger: {
        ...noopLogger,
        warn: (payload, message) => {
          warnCalls.push({ payload, message })
        },
      },
      exit: (code) => {
        timeline.push(`exited:${code}`)
      },
    })
    await handle.shutdown('SIGTERM')
    expect(timeline).toEqual(['exited:1'])
    expect(warnCalls).toEqual([
      {
        payload: {
          event: 'shutdown_step_failed',
          step: 'close_http_server',
          error: closeError.message,
        },
        message: 'shutdown step failed',
      },
    ])
  })
})
