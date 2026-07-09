import { describe, expect, it } from 'vitest'

import { noopLogger } from '@/logger/logger'
import { createShutdownHandler } from '@/server/shutdown'

const createDeferred = <T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('createShutdownHandler', () => {
  it('sets not-ready, closes the server, drains in-flight tasks, then exits', async () => {
    const timeline: string[] = []
    const idle = createDeferred<undefined>()
    const exitCodes: number[] = []
    const handler = createShutdownHandler({
      health: {
        setNotReady: () => timeline.push('not-ready'),
      },
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
        exitCodes.push(code)
        timeline.push('exited')
      },
    })
    const result = handler('SIGTERM')
    idle.resolve(undefined)
    await result
    expect(timeline).toEqual([
      'not-ready',
      'server-closed',
      'drained',
      'exited',
    ])
    expect(exitCodes).toEqual([0])
  })

  it('ignores a second signal received while already shutting down', async () => {
    let closeCalls = 0
    const idle = createDeferred<undefined>()
    const handler = createShutdownHandler({
      health: { setNotReady: () => {} },
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
    const first = handler('SIGTERM')
    await handler('SIGTERM')
    idle.resolve(undefined)
    await first
    expect(closeCalls).toBe(1)
  })
})
