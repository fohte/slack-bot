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
