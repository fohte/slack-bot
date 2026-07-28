import { describe, expect, it } from 'vitest'

import { createThreadTurnQueue } from '#plugins/llm-agent/thread-turn-queue'
import { createDeferred } from '#server/_test-utils'

describe('createThreadTurnQueue', () => {
  it('runs a single call for a threadId to completion and returns its result', async () => {
    const queue = createThreadTurnQueue()

    const result = await queue.run('T1', async () => 'done')

    expect(result).toBe('done')
  })

  it('serializes calls sharing the same threadId, starting the second only after the first settles', async () => {
    const queue = createThreadTurnQueue()
    const first = createDeferred<string>()
    const order: string[] = []

    const firstRun = queue.run('T1', async () => {
      order.push('first-start')
      const value = await first.promise
      order.push('first-end')
      return value
    })
    const secondRun = queue.run('T1', async () => {
      order.push('second-start')
      return 'second'
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['first-start'])

    first.resolve('first')
    expect(await firstRun).toBe('first')
    expect(await secondRun).toBe('second')
    expect(order).toEqual(['first-start', 'first-end', 'second-start'])
  })

  it('runs calls for different threadIds concurrently', async () => {
    const queue = createThreadTurnQueue()
    const first = createDeferred<string>()
    const order: string[] = []

    const firstRun = queue.run('T1', async () => {
      order.push('t1-start')
      const value = await first.promise
      order.push('t1-end')
      return value
    })
    const secondRun = queue.run('T2', async () => {
      order.push('t2-start')
      return 't2'
    })

    expect(await secondRun).toBe('t2')
    expect(order).toEqual(['t1-start', 't2-start'])

    first.resolve('t1')
    expect(await firstRun).toBe('t1')
  })

  it('lets a later call proceed even when an earlier call for the same threadId rejects', async () => {
    const queue = createThreadTurnQueue()

    const firstRun = queue.run('T1', async () => {
      throw new Error('boom')
    })
    const secondRun = queue.run('T1', async () => 'recovered')

    await expect(firstRun).rejects.toThrow('boom')
    expect(await secondRun).toBe('recovered')
  })
})
