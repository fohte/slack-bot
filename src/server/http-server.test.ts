import { describe, expect, it } from 'vitest'

import { noopLogger } from '@/logger/logger'
import type { InteractionRouter } from '@/router/router'
import type { SignatureVerifier } from '@/security/signature-verifier'
import { createDeferred } from '@/server/_test-utils'
import { createHttpServer } from '@/server/http-server'
import { createInFlightTasks } from '@/server/in-flight-tasks'

const allowAllVerifier: SignatureVerifier = { verify: () => true }

const noopRouter: InteractionRouter = {
  async routeCommand() {
    return { status: 404 }
  },
  async routeInteractivity() {
    return { status: 404 }
  },
  async routeEvent() {},
}

describe('createHttpServer', () => {
  it('tracks the backgrounded routeEvent() call so it outlives the HTTP response', async () => {
    const routeEventResult = createDeferred<undefined>()
    const router: InteractionRouter = {
      ...noopRouter,
      async routeEvent() {
        await routeEventResult.promise
      },
    }
    const inFlightTasks = createInFlightTasks()
    const timeline: string[] = []
    const { app } = createHttpServer({
      verifier: allowAllVerifier,
      router,
      logger: noopLogger,
      inFlightTasks,
    })

    const response = await app.request('/api/slack/events', {
      method: 'POST',
      body: JSON.stringify({
        type: 'event_callback',
        event: { type: 'app_mention' },
      }),
    })
    timeline.push(`response:${response.status}`)
    void inFlightTasks.waitForIdle().then(() => timeline.push('idle'))
    // routeEvent() is still awaiting routeEventResult, so this must land
    // in the timeline before 'idle' does.
    await Promise.resolve()
    timeline.push('checked-still-in-flight')

    routeEventResult.resolve(undefined)
    await inFlightTasks.waitForIdle()
    expect(timeline).toEqual([
      'response:200',
      'checked-still-in-flight',
      'idle',
    ])
  })

  it('mounts a plugin-provided route without requiring a Slack signature', async () => {
    const rejectingVerifier: SignatureVerifier = { verify: () => false }
    const { app } = createHttpServer({
      verifier: rejectingVerifier,
      router: noopRouter,
      logger: noopLogger,
      inFlightTasks: createInFlightTasks(),
      routes: [
        {
          path: '/api/a2a/notifications',
          handler: (c) => Promise.resolve(c.body(null, 204)),
        },
      ],
    })

    const response = await app.request('/api/a2a/notifications', {
      method: 'POST',
      body: '{}',
    })

    expect(response.status).toBe(204)
  })
})
