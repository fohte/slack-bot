import { describe, expect, it, vi } from 'vitest'

import {
  createScriptedEventLogStore,
  createScriptedThreadSessionStore,
  createStubSlackClient,
  fixedOpencodeClient,
  noopConfigMapClient,
} from '@/plugins/llm-agent/_test-utils'
import type { EventLogRow } from '@/plugins/llm-agent/event-log-store'
import type { ResponseReconcilerOptions } from '@/plugins/llm-agent/response-reconciler'
import {
  RESPONSE_RECONCILER_DEFAULT_GRACE_MS,
  RESPONSE_RECONCILER_DEFAULT_INTERVAL_MS,
  startResponseReconciler,
} from '@/plugins/llm-agent/response-reconciler'
import type {
  TaskCrClient,
  TaskCrStatus,
} from '@/plugins/llm-agent/task-cr-client'
import { createDeferred } from '@/server/_test-utils'
import { createInFlightTasks } from '@/server/in-flight-tasks'

const row = (overrides: Partial<EventLogRow> = {}): EventLogRow => ({
  slackEventId: 'Ev1',
  outcome: 'accepted',
  slackTeamId: 'T1',
  slackChannelId: 'C1',
  threadRootTs: '111.222',
  taskName: 'task-1',
  ...overrides,
})

interface FixedTaskCrClient extends TaskCrClient {
  readonly listCalls: () => number
}

const createFixedTaskCrClient = (
  statuses: readonly TaskCrStatus[],
  listImpl?: () => Promise<readonly TaskCrStatus[]>,
): FixedTaskCrClient => {
  let calls = 0
  return {
    listCalls: () => calls,
    async create() {
      throw new Error('not used in reconciler tests')
    },
    async list() {
      calls += 1
      return listImpl ? await listImpl() : statuses
    },
  }
}

const baseDeps = (
  overrides: Partial<ResponseReconcilerOptions> = {},
): ResponseReconcilerOptions => ({
  configMapClient: noopConfigMapClient,
  taskCrClient: createFixedTaskCrClient([]),
  opencodeClient: fixedOpencodeClient({
    sessionId: 'ses_xyz',
    assistantText: 'answer',
  }),
  eventLogStore: createScriptedEventLogStore(),
  threadSessionStore: createScriptedThreadSessionStore(),
  slackClient: createStubSlackClient(),
  ...overrides,
})

describe('startResponseReconciler', () => {
  it('recovers a Completed task by posting the Slack response and marking it responded', async () => {
    const slackClient = createStubSlackClient()
    const eventLogStore = createScriptedEventLogStore({
      findDispatchedUnresponded: () => [row()],
    })
    const taskCrClient = createFixedTaskCrClient([
      {
        name: 'task-1',
        namespace: 'kubeopencode',
        phase: 'Completed',
        message: undefined,
      },
    ])
    const handle = startResponseReconciler(
      baseDeps({ slackClient, eventLogStore, taskCrClient }),
    )

    const recovered = await handle.runOnce()

    const actual = {
      recovered,
      slackCalls: slackClient.calls,
      markedResponded: eventLogStore.markedResponded,
    }
    expect(actual).toEqual({
      recovered: 1,
      slackCalls: [
        {
          kind: 'post',
          channel: 'C1',
          thread: '111.222',
          text: 'answer',
          blocks: [{ type: 'markdown', text: 'answer' }],
          loadingMessages: undefined,
        },
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: '',
          blocks: undefined,
          loadingMessages: undefined,
        },
      ],
      markedResponded: ['Ev1'],
    })
  })

  it('recovers a Failed task by posting the failure message', async () => {
    const slackClient = createStubSlackClient()
    const eventLogStore = createScriptedEventLogStore({
      findDispatchedUnresponded: () => [row()],
    })
    const taskCrClient = createFixedTaskCrClient([
      {
        name: 'task-1',
        namespace: 'kubeopencode',
        phase: 'Failed',
        message: 'boom',
      },
    ])
    const handle = startResponseReconciler(
      baseDeps({ slackClient, eventLogStore, taskCrClient }),
    )

    const recovered = await handle.runOnce()

    const actual = { recovered, slackCalls: slackClient.calls }
    expect(actual).toEqual({
      recovered: 1,
      slackCalls: [
        {
          kind: 'post',
          channel: 'C1',
          thread: '111.222',
          text: 'Task failed: boom',
          blocks: undefined,
          loadingMessages: undefined,
        },
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: '',
          blocks: undefined,
          loadingMessages: undefined,
        },
      ],
    })
  })

  it('does nothing for a Task CR that is still running', async () => {
    const slackClient = createStubSlackClient()
    const eventLogStore = createScriptedEventLogStore({
      findDispatchedUnresponded: () => [row()],
    })
    const taskCrClient = createFixedTaskCrClient([
      {
        name: 'task-1',
        namespace: 'kubeopencode',
        phase: 'Running',
        message: undefined,
      },
    ])
    const handle = startResponseReconciler(
      baseDeps({ slackClient, eventLogStore, taskCrClient }),
    )

    const recovered = await handle.runOnce()

    const actual = { recovered, slackCalls: slackClient.calls }
    expect(actual).toEqual({
      recovered: 0,
      slackCalls: [],
    })
  })

  it('marks the row responded without posting when no Task CR in the namespace matches it, so it is never reconciled again', async () => {
    const slackClient = createStubSlackClient()
    const eventLogStore = createScriptedEventLogStore({
      findDispatchedUnresponded: () => [row()],
    })
    const taskCrClient = createFixedTaskCrClient([])
    const handle = startResponseReconciler(
      baseDeps({ slackClient, eventLogStore, taskCrClient }),
    )

    const recovered = await handle.runOnce()

    const actual = {
      recovered,
      slackCalls: slackClient.calls,
      markedResponded: eventLogStore.markedResponded,
    }
    expect(actual).toEqual({
      recovered: 0,
      slackCalls: [],
      markedResponded: ['Ev1'],
    })
  })

  it('skips a row missing envelope fields instead of throwing', async () => {
    const slackClient = createStubSlackClient()
    const eventLogStore = createScriptedEventLogStore({
      findDispatchedUnresponded: () => [row({ slackChannelId: undefined })],
    })
    const taskCrClient = createFixedTaskCrClient([
      {
        name: 'task-1',
        namespace: 'kubeopencode',
        phase: 'Completed',
        message: undefined,
      },
    ])
    const handle = startResponseReconciler(
      baseDeps({ slackClient, eventLogStore, taskCrClient }),
    )

    const recovered = await handle.runOnce()

    const actual = { recovered, slackCalls: slackClient.calls }
    expect(actual).toEqual({
      recovered: 0,
      slackCalls: [],
    })
  })

  it('does not call taskCrClient.list when there are no dispatched-but-unresponded rows', async () => {
    const taskCrClient = createFixedTaskCrClient([])
    const eventLogStore = createScriptedEventLogStore({
      findDispatchedUnresponded: () => [],
    })
    const handle = startResponseReconciler(
      baseDeps({ eventLogStore, taskCrClient }),
    )

    const recovered = await handle.runOnce()

    const actual = { recovered, listCalls: taskCrClient.listCalls() }
    expect(actual).toEqual({
      recovered: 0,
      listCalls: 0,
    })
  })

  it('processes multiple rows in one tick, recovering only the terminal ones', async () => {
    const slackClient = createStubSlackClient()
    const eventLogStore = createScriptedEventLogStore({
      findDispatchedUnresponded: () => [
        row({ slackEventId: 'Ev1', taskName: 'task-1' }),
        row({ slackEventId: 'Ev2', taskName: 'task-2' }),
        row({ slackEventId: 'Ev3', taskName: 'task-3' }),
      ],
    })
    const taskCrClient = createFixedTaskCrClient([
      {
        name: 'task-1',
        namespace: 'kubeopencode',
        phase: 'Completed',
        message: undefined,
      },
      {
        name: 'task-2',
        namespace: 'kubeopencode',
        phase: 'Running',
        message: undefined,
      },
      {
        name: 'task-3',
        namespace: 'kubeopencode',
        phase: 'Failed',
        message: 'oops',
      },
    ])
    const handle = startResponseReconciler(
      baseDeps({ slackClient, eventLogStore, taskCrClient }),
    )

    const recovered = await handle.runOnce()

    const actual = { recovered, slackCalls: slackClient.calls }
    expect(actual).toEqual({
      recovered: 2,
      slackCalls: [
        {
          kind: 'post',
          channel: 'C1',
          thread: '111.222',
          text: 'answer',
          blocks: [{ type: 'markdown', text: 'answer' }],
          loadingMessages: undefined,
        },
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: '',
          blocks: undefined,
          loadingMessages: undefined,
        },
        {
          kind: 'post',
          channel: 'C1',
          thread: '111.222',
          text: 'Task failed: oops',
          blocks: undefined,
          loadingMessages: undefined,
        },
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: '',
          blocks: undefined,
          loadingMessages: undefined,
        },
      ],
    })
  })

  it('returns 0 and swallows the error when findDispatchedUnresponded throws', async () => {
    const eventLogStore = createScriptedEventLogStore({
      findDispatchedUnresponded: () => {
        throw new Error('db down')
      },
    })
    const handle = startResponseReconciler(baseDeps({ eventLogStore }))

    await expect(handle.runOnce()).resolves.toBe(0)
  })

  it('returns 0 and swallows the error when taskCrClient.list throws', async () => {
    const eventLogStore = createScriptedEventLogStore({
      findDispatchedUnresponded: () => [row()],
    })
    const taskCrClient = createFixedTaskCrClient([], async () => {
      throw new Error('k8s unreachable')
    })
    const handle = startResponseReconciler(
      baseDeps({ eventLogStore, taskCrClient }),
    )

    await expect(handle.runOnce()).resolves.toBe(0)
  })

  it('continues to the next row when respond() throws while posting for an earlier row', async () => {
    const eventLogStore = createScriptedEventLogStore({
      findDispatchedUnresponded: () => [
        row({ slackEventId: 'Ev1', taskName: 'task-1' }),
        row({ slackEventId: 'Ev2', taskName: 'task-2' }),
      ],
    })
    const taskCrClient = createFixedTaskCrClient([
      {
        name: 'task-1',
        namespace: 'kubeopencode',
        phase: 'Completed',
        message: undefined,
      },
      {
        name: 'task-2',
        namespace: 'kubeopencode',
        phase: 'Completed',
        message: undefined,
      },
    ])
    const slackClient = createStubSlackClient()
    let postCalls = 0
    const originalPostMessage = slackClient.postMessage.bind(slackClient)
    slackClient.postMessage = (async (
      arg: Parameters<typeof originalPostMessage>[0],
    ) => {
      postCalls += 1
      if (postCalls === 1) throw new Error('slack down')
      return originalPostMessage(arg)
    }) as typeof slackClient.postMessage
    const handle = startResponseReconciler(
      baseDeps({ slackClient, eventLogStore, taskCrClient }),
    )

    const recovered = await handle.runOnce()

    const actual = { recovered, slackCalls: slackClient.calls }
    expect(actual).toEqual({
      recovered: 1,
      slackCalls: [
        {
          kind: 'post',
          channel: 'C1',
          thread: '111.222',
          text: 'answer',
          blocks: [{ type: 'markdown', text: 'answer' }],
          loadingMessages: undefined,
        },
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: '',
          blocks: undefined,
          loadingMessages: undefined,
        },
      ],
    })
  })

  it('passes now() - graceMs as the received-before cutoff to findDispatchedUnresponded', async () => {
    const seenCutoffs: Date[] = []
    const eventLogStore = createScriptedEventLogStore({
      findDispatchedUnresponded: (receivedBefore) => {
        seenCutoffs.push(receivedBefore)
        return []
      },
    })
    const handle = startResponseReconciler(
      baseDeps({ eventLogStore, graceMs: 5_000, now: () => 100_000 }),
    )

    await handle.runOnce()

    expect(seenCutoffs).toEqual([new Date(95_000)])
  })

  it('skips a run that starts while a previous run is still in flight', async () => {
    let releasePendingQuery: (() => void) | undefined
    let queryCalls = 0
    const eventLogStore = createScriptedEventLogStore({
      findDispatchedUnresponded: () => {
        queryCalls += 1
        return new Promise<readonly EventLogRow[]>((resolve) => {
          releasePendingQuery = () => resolve([])
        })
      },
    })
    const handle = startResponseReconciler(baseDeps({ eventLogStore }))

    const firstRun = handle.runOnce()
    const secondRun = handle.runOnce()
    // Assert before releasing the pending query: if the isRunning guard
    // regresses, the second call reaches findDispatchedUnresponded too and
    // overwrites releasePendingQuery, leaving the first call's Promise
    // pending forever — which would otherwise surface as an opaque test
    // timeout instead of this clear assertion failure.
    expect(queryCalls).toBe(1)
    releasePendingQuery?.()
    const [firstResult, secondResult] = await Promise.all([firstRun, secondRun])

    const actual = { firstResult, secondResult }
    expect(actual).toEqual({
      firstResult: 0,
      secondResult: 0,
    })
  })

  it('schedules the reconciler on the requested interval and stop clears it', () => {
    const fakeTimer = Symbol('timer') as unknown as NodeJS.Timeout
    const setIntervalImpl = vi.fn<
      (callback: () => void, ms: number) => NodeJS.Timeout
    >(() => fakeTimer)
    const clearIntervalImpl = vi.fn<(handle: NodeJS.Timeout) => void>()
    const handle = startResponseReconciler(
      baseDeps({ intervalMs: 12_345, setIntervalImpl, clearIntervalImpl }),
    )

    expect(setIntervalImpl.mock.calls.map((args) => args[1])).toEqual([12_345])

    handle.stop()
    expect(clearIntervalImpl.mock.calls).toEqual([[fakeTimer]])
  })

  it('tracks a handle.runOnce() call in inFlightTasks so a shutdown drain waits for it', async () => {
    const gate = createDeferred<undefined>()
    const eventLogStore = createScriptedEventLogStore({
      findDispatchedUnresponded: async () => {
        await gate.promise
        return []
      },
    })
    const inFlightTasks = createInFlightTasks()
    const handle = startResponseReconciler(
      baseDeps({ eventLogStore, inFlightTasks }),
    )
    const timeline: string[] = []

    void handle.runOnce()
    void inFlightTasks.waitForIdle().then(() => timeline.push('idle'))
    await Promise.resolve()
    timeline.push('checked-still-in-flight')

    gate.resolve(undefined)
    await inFlightTasks.waitForIdle()
    expect(timeline).toEqual(['checked-still-in-flight', 'idle'])
  })

  it('tracks an interval-triggered run in inFlightTasks', () => {
    let tick: (() => void) | undefined
    const setIntervalImpl = vi.fn<
      (callback: () => void, ms: number) => NodeJS.Timeout
    >((callback) => {
      tick = callback
      return Symbol('timer') as unknown as NodeJS.Timeout
    })
    const inFlightTasks = createInFlightTasks()
    startResponseReconciler(baseDeps({ setIntervalImpl, inFlightTasks }))

    expect(inFlightTasks.size()).toBe(0)
    tick?.()
    expect(inFlightTasks.size()).toBe(1)
  })

  it('exposes default grace and interval constants used when options are omitted', () => {
    const actual = {
      graceMs: RESPONSE_RECONCILER_DEFAULT_GRACE_MS,
      intervalMs: RESPONSE_RECONCILER_DEFAULT_INTERVAL_MS,
    }
    expect(actual).toEqual({
      graceMs: 2 * 60 * 1000,
      intervalMs: 60 * 1000,
    })
  })
})
