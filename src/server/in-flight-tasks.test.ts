import { describe, expect, it } from 'vitest'

import { createDeferred } from '@/server/_test-utils'
import { createInFlightTasks } from '@/server/in-flight-tasks'

describe('createInFlightTasks', () => {
  it('resolves track() to the tracked promise value', async () => {
    const tasks = createInFlightTasks()
    await expect(tasks.track(Promise.resolve('done'))).resolves.toBe('done')
  })

  it('resolves waitForIdle() immediately when nothing is tracked', async () => {
    const tasks = createInFlightTasks()
    await expect(tasks.waitForIdle()).resolves.toBeUndefined()
  })

  it('waits for a tracked promise to settle before resolving idle', async () => {
    const tasks = createInFlightTasks()
    const deferred = createDeferred<undefined>()
    const timeline: string[] = []
    void tasks.track(deferred.promise).then(() => timeline.push('task'))
    const idle = tasks.waitForIdle().then(() => timeline.push('idle'))
    deferred.resolve(undefined)
    await idle
    expect(timeline).toEqual(['task', 'idle'])
  })

  it('waits for a task tracked after a drain is already in progress', async () => {
    const tasks = createInFlightTasks()
    const first = createDeferred<undefined>()
    const second = createDeferred<undefined>()
    const timeline: string[] = []
    void tasks.track(first.promise)
    const idle = tasks.waitForIdle().then(() => timeline.push('idle'))
    void tasks.track(second.promise).then(() => timeline.push('second'))
    first.resolve(undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    second.resolve(undefined)
    await idle
    expect(timeline).toEqual(['second', 'idle'])
  })

  it('does not let a rejected tracked promise break waitForIdle()', async () => {
    const tasks = createInFlightTasks()
    const rejecting = Promise.reject(new Error('boom'))
    void tasks.track(rejecting).catch(() => {})
    await expect(tasks.waitForIdle()).resolves.toBeUndefined()
  })

  it('reports the number of tasks currently tracked', async () => {
    const tasks = createInFlightTasks()
    const deferred = createDeferred<undefined>()
    expect(tasks.size()).toBe(0)
    void tasks.track(deferred.promise)
    expect(tasks.size()).toBe(1)
    deferred.resolve(undefined)
    await tasks.waitForIdle()
    expect(tasks.size()).toBe(0)
  })
})
