import { describe, expect, it } from 'vitest'

import { noopLogger } from '@/logger/logger'
import { createDeferred } from '@/server/_test-utils'
import { createShutdownHandler } from '@/server/shutdown'

describe('createShutdownHandler', () => {
  it('sets not-ready, closes the server, drains in-flight tasks, then exits', async () => {
    const timeline: string[] = []
    const idle = createDeferred<undefined>()
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
        timeline.push(`exited:${code}`)
      },
    })
    const result = handler('SIGTERM')
    idle.resolve(undefined)
    await result
    expect(timeline).toEqual([
      'not-ready',
      'server-closed',
      'drained',
      'exited:0',
    ])
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
