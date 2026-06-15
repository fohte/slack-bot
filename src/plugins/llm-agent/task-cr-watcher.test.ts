import { describe, expect, it } from 'vitest'

import type { TaskResponseOutcome } from '@/plugins/llm-agent/response-handler'
import type {
  TaskCrClient,
  TaskCrCreateOutcome,
  TaskCrStatus,
} from '@/plugins/llm-agent/task-cr-client'
import { startTaskCrWatcher } from '@/plugins/llm-agent/task-cr-watcher'

interface StubTaskCrClient extends TaskCrClient {
  readonly listCalls: ReadonlyArray<string>
}

const createStubTaskCrClient = (
  pages: ReadonlyArray<readonly TaskCrStatus[]> | Error,
): StubTaskCrClient => {
  const listCalls: string[] = []
  let cursor = 0
  return {
    listCalls,
    async create(): Promise<TaskCrCreateOutcome> {
      return 'created'
    },
    async list(namespace) {
      listCalls.push(namespace)
      if (pages instanceof Error) throw pages
      const page = pages[Math.min(cursor, pages.length - 1)] ?? []
      cursor += 1
      return page
    },
  }
}

const noopSetInterval = (() => 0 as unknown as NodeJS.Timeout) as (
  cb: () => void,
  ms: number,
) => NodeJS.Timeout
const noopClearInterval = (() => {}) as (h: NodeJS.Timeout) => void

describe('startTaskCrWatcher', () => {
  it('dispatches Completed and Failed Tasks to the handler and skips non-terminal phases', async () => {
    const tasks: TaskCrStatus[] = [
      {
        name: 'slack-aaa',
        namespace: 'kubeopencode',
        phase: 'Completed',
        message: undefined,
      },
      {
        name: 'slack-bbb',
        namespace: 'kubeopencode',
        phase: 'Running',
        message: undefined,
      },
      {
        name: 'slack-ccc',
        namespace: 'kubeopencode',
        phase: 'Failed',
        message: 'boom',
      },
    ]
    const client = createStubTaskCrClient([tasks])
    const handled: TaskCrStatus[] = []
    const watcher = startTaskCrWatcher({
      taskCrClient: client,
      handler: async (task): Promise<TaskResponseOutcome> => {
        handled.push(task)
        return 'responded'
      },
      namespace: 'kubeopencode',
      setIntervalImpl: noopSetInterval,
      clearIntervalImpl: noopClearInterval,
    })

    const responded = await watcher.runOnce()

    expect({
      responded,
      listCalls: client.listCalls,
      handledNames: handled.map((t) => t.name),
    }).toEqual({
      responded: 2,
      listCalls: ['kubeopencode'],
      handledNames: ['slack-aaa', 'slack-ccc'],
    })
  })

  it('continues processing remaining Tasks when one handler throws', async () => {
    const tasks: TaskCrStatus[] = [
      {
        name: 'slack-aaa',
        namespace: 'kubeopencode',
        phase: 'Completed',
        message: undefined,
      },
      {
        name: 'slack-bbb',
        namespace: 'kubeopencode',
        phase: 'Completed',
        message: undefined,
      },
    ]
    const client = createStubTaskCrClient([tasks])
    const handled: string[] = []
    const watcher = startTaskCrWatcher({
      taskCrClient: client,
      handler: async (task) => {
        handled.push(task.name)
        if (task.name === 'slack-aaa') throw new Error('boom')
        return 'responded'
      },
      namespace: 'kubeopencode',
      setIntervalImpl: noopSetInterval,
      clearIntervalImpl: noopClearInterval,
    })

    const responded = await watcher.runOnce()

    expect({ responded, handled }).toEqual({
      responded: 1,
      handled: ['slack-aaa', 'slack-bbb'],
    })
  })

  it('returns 0 and does not throw when the list call fails', async () => {
    const client = createStubTaskCrClient(new Error('connection refused'))
    const watcher = startTaskCrWatcher({
      taskCrClient: client,
      handler: async () => 'responded',
      namespace: 'kubeopencode',
      setIntervalImpl: noopSetInterval,
      clearIntervalImpl: noopClearInterval,
    })

    await expect(watcher.runOnce()).resolves.toBe(0)
  })

  it('invokes onPhaseTransition only when a Task CR phase changes between ticks', async () => {
    const tick1: TaskCrStatus[] = [
      {
        name: 'slack-aaa',
        namespace: 'kubeopencode',
        phase: 'Pending',
        message: undefined,
      },
      {
        name: 'slack-bbb',
        namespace: 'kubeopencode',
        phase: 'Running',
        message: undefined,
      },
    ]
    const tick2: TaskCrStatus[] = [
      {
        name: 'slack-aaa',
        namespace: 'kubeopencode',
        phase: 'Running',
        message: undefined,
      },
      {
        name: 'slack-bbb',
        namespace: 'kubeopencode',
        phase: 'Running',
        message: undefined,
      },
    ]
    const tick3: TaskCrStatus[] = [
      {
        name: 'slack-aaa',
        namespace: 'kubeopencode',
        phase: 'Completed',
        message: undefined,
      },
      {
        name: 'slack-bbb',
        namespace: 'kubeopencode',
        phase: 'Running',
        message: undefined,
      },
    ]
    const client = createStubTaskCrClient([tick1, tick2, tick3])
    const transitions: Array<{ name: string; phase: string | undefined }> = []
    const watcher = startTaskCrWatcher({
      taskCrClient: client,
      handler: async () => 'responded',
      onPhaseTransition: (task) => {
        transitions.push({ name: task.name, phase: task.phase })
      },
      namespace: 'kubeopencode',
      setIntervalImpl: noopSetInterval,
      clearIntervalImpl: noopClearInterval,
    })

    const responded1 = await watcher.runOnce()
    const responded2 = await watcher.runOnce()
    const responded3 = await watcher.runOnce()

    expect({ responded1, responded2, responded3, transitions }).toEqual({
      responded1: 0,
      responded2: 0,
      responded3: 1,
      transitions: [
        { name: 'slack-aaa', phase: 'Pending' },
        { name: 'slack-bbb', phase: 'Running' },
        { name: 'slack-aaa', phase: 'Running' },
        { name: 'slack-aaa', phase: 'Completed' },
      ],
    })
  })

  it('retries onPhaseTransition on the next tick when a previous invocation threw', async () => {
    const tasks: TaskCrStatus[] = [
      {
        name: 'slack-aaa',
        namespace: 'kubeopencode',
        phase: 'Running',
        message: undefined,
      },
    ]
    const client = createStubTaskCrClient([tasks, tasks])
    let attempts = 0
    const observed: Array<{ name: string; phase: string | undefined }> = []
    const watcher = startTaskCrWatcher({
      taskCrClient: client,
      handler: async () => 'responded',
      onPhaseTransition: (task) => {
        attempts += 1
        if (attempts === 1) throw new Error('boom')
        observed.push({ name: task.name, phase: task.phase })
      },
      namespace: 'kubeopencode',
      setIntervalImpl: noopSetInterval,
      clearIntervalImpl: noopClearInterval,
    })

    await watcher.runOnce()
    await watcher.runOnce()

    expect({ attempts, observed }).toEqual({
      attempts: 2,
      observed: [{ name: 'slack-aaa', phase: 'Running' }],
    })
  })

  it('continues processing remaining Tasks when onPhaseTransition throws', async () => {
    const tasks: TaskCrStatus[] = [
      {
        name: 'slack-aaa',
        namespace: 'kubeopencode',
        phase: 'Running',
        message: undefined,
      },
      {
        name: 'slack-bbb',
        namespace: 'kubeopencode',
        phase: 'Completed',
        message: undefined,
      },
    ]
    const client = createStubTaskCrClient([tasks])
    const handled: string[] = []
    const watcher = startTaskCrWatcher({
      taskCrClient: client,
      handler: async (task) => {
        handled.push(task.name)
        return 'responded'
      },
      onPhaseTransition: () => {
        throw new Error('boom')
      },
      namespace: 'kubeopencode',
      setIntervalImpl: noopSetInterval,
      clearIntervalImpl: noopClearInterval,
    })

    const responded = await watcher.runOnce()

    expect({ responded, handled }).toEqual({
      responded: 1,
      handled: ['slack-bbb'],
    })
  })

  it('resyncs on startup by processing terminal Tasks on the first tick', async () => {
    const tasks: TaskCrStatus[] = [
      {
        name: 'slack-old-success',
        namespace: 'kubeopencode',
        phase: 'Completed',
        message: undefined,
      },
      {
        name: 'slack-old-failure',
        namespace: 'kubeopencode',
        phase: 'Failed',
        message: 'broke',
      },
    ]
    const client = createStubTaskCrClient([tasks])
    const handled: string[] = []
    const watcher = startTaskCrWatcher({
      taskCrClient: client,
      handler: async (task) => {
        handled.push(task.name)
        return 'responded'
      },
      namespace: 'kubeopencode',
      setIntervalImpl: noopSetInterval,
      clearIntervalImpl: noopClearInterval,
    })

    const responded = await watcher.runOnce()

    expect({ responded, handled }).toEqual({
      responded: 2,
      handled: ['slack-old-success', 'slack-old-failure'],
    })
  })
})
