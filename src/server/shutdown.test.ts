import { describe, expect, it } from 'vitest'

import { noopLogger } from '@/logger/logger'
import { createDeferred } from '@/server/_test-utils'
import { createShutdownHandler } from '@/server/shutdown'

describe('createShutdownHandler', () => {
  it('drains in-flight tasks, closes the server, then exits', async () => {
    const timeline: string[] = []
    const idle = createDeferred<undefined>()
    const handler = createShutdownHandler({
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
        size: () => 0,
      },
      logger: noopLogger,
      exit: (code) => {
        timeline.push(`exited:${code}`)
      },
    })
    const result = handler('SIGTERM')
    idle.resolve(undefined)
    await result
    expect(timeline).toEqual(['drained', 'server-closed', 'exited:0'])
  })

  it('ignores a second signal received while already shutting down', async () => {
    let closeCalls = 0
    const idle = createDeferred<undefined>()
    const handler = createShutdownHandler({
      server: {
        close: (callback) => {
          closeCalls += 1
          callback?.()
        },
      },
      inFlightTasks: { waitForIdle: () => idle.promise, size: () => 0 },
      logger: noopLogger,
      exit: () => {},
    })
    const first = handler('SIGTERM')
    await handler('SIGTERM')
    idle.resolve(undefined)
    await first
    expect(closeCalls).toBe(1)
  })

  it('logs and still exits when server.close reports an error', async () => {
    const errorCalls: Array<{
      payload: Record<string, unknown>
      message: string | undefined
    }> = []
    const timeline: string[] = []
    const closeError = new Error('already closed')
    const handler = createShutdownHandler({
      server: {
        close: (callback) => {
          callback?.(closeError)
        },
      },
      inFlightTasks: { waitForIdle: async () => {}, size: () => 0 },
      logger: {
        ...noopLogger,
        error: (payload, message) => {
          errorCalls.push({ payload, message })
        },
      },
      exit: (code) => {
        timeline.push(`exited:${code}`)
      },
    })
    await handler('SIGTERM')
    expect(timeline).toEqual(['exited:0'])
    expect(errorCalls).toEqual([
      {
        payload: { event: 'shutdown_server_close_failed', err: closeError },
        message: 'failed to close http server',
      },
    ])
  })
})
