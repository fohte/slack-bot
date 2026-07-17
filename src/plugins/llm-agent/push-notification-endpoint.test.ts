import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import { createRecordingLogger } from '@/plugins/llm-agent/_test-utils'
import { createA2aNotificationHandler } from '@/plugins/llm-agent/push-notification-endpoint'
import type { ResponseFinalizer } from '@/plugins/llm-agent/response-finalizer'

const TOKEN = 'shared-secret'

const createFakeResponseFinalizer = (
  finalize: (taskId: string) => Promise<void> = async () => {},
): ResponseFinalizer & { readonly calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    async finalize(taskId) {
      calls.push(taskId)
      await finalize(taskId)
    },
    async finalizeRow() {
      throw new Error('not implemented')
    },
    async finalizeTask() {
      throw new Error('not implemented')
    },
  }
}

const buildApp = (
  responseFinalizer: ResponseFinalizer,
  logger = createRecordingLogger(),
): Hono => {
  const app = new Hono()
  app.post(
    '/api/a2a/notifications',
    createA2aNotificationHandler({ token: TOKEN, responseFinalizer, logger }),
  )
  return app
}

describe('createA2aNotificationHandler', () => {
  it('returns 401 when the token header is missing', async () => {
    const finalizer = createFakeResponseFinalizer()
    const app = buildApp(finalizer)

    const response = await app.request('/api/a2a/notifications', {
      method: 'POST',
      body: JSON.stringify({ id: 'task-1' }),
    })

    expect(response.status).toBe(401)
    expect(finalizer.calls).toEqual([])
  })

  it('returns 401 when the token does not match', async () => {
    const finalizer = createFakeResponseFinalizer()
    const app = buildApp(finalizer)

    const response = await app.request('/api/a2a/notifications', {
      method: 'POST',
      headers: { 'X-A2A-Notification-Token': 'wrong' },
      body: JSON.stringify({ id: 'task-1' }),
    })

    expect(response.status).toBe(401)
    expect(finalizer.calls).toEqual([])
  })

  it('returns 400 for a body that is not valid JSON', async () => {
    const finalizer = createFakeResponseFinalizer()
    const app = buildApp(finalizer)

    const response = await app.request('/api/a2a/notifications', {
      method: 'POST',
      headers: { 'X-A2A-Notification-Token': TOKEN },
      body: 'not json',
    })

    expect(response.status).toBe(400)
    expect(finalizer.calls).toEqual([])
  })

  it('returns 400 when the payload has no taskId', async () => {
    const finalizer = createFakeResponseFinalizer()
    const app = buildApp(finalizer)

    const response = await app.request('/api/a2a/notifications', {
      method: 'POST',
      headers: { 'X-A2A-Notification-Token': TOKEN },
      body: JSON.stringify({ contextId: 'ctx-1' }),
    })

    expect(response.status).toBe(400)
    expect(finalizer.calls).toEqual([])
  })

  it('finalizes the task and returns 204 for a valid, authenticated push, using only its taskId', async () => {
    const finalizer = createFakeResponseFinalizer()
    const app = buildApp(finalizer)

    const response = await app.request('/api/a2a/notifications', {
      method: 'POST',
      headers: { 'X-A2A-Notification-Token': TOKEN },
      body: JSON.stringify({
        kind: 'task',
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'completed' },
      }),
    })

    expect(response.status).toBe(204)
    expect(finalizer.calls).toEqual(['task-1'])
  })

  it('still returns 204 when finalize() throws, logging the failure instead of surfacing an error status', async () => {
    const logger = createRecordingLogger()
    const finalizeError = new Error('db unavailable')
    const finalizer = createFakeResponseFinalizer(async () => {
      throw finalizeError
    })
    const app = buildApp(finalizer, logger)

    const response = await app.request('/api/a2a/notifications', {
      method: 'POST',
      headers: { 'X-A2A-Notification-Token': TOKEN },
      body: JSON.stringify({ id: 'task-1' }),
    })

    expect(response.status).toBe(204)
    expect(logger.entries).toEqual([
      {
        level: 'error',
        payload: {
          event: 'llm_agent_a2a_notification_finalize_failed',
          task_id: 'task-1',
          err: finalizeError,
        },
        message:
          'llm-agent failed to finalize a task after receiving a push notification',
      },
    ])
  })
})
