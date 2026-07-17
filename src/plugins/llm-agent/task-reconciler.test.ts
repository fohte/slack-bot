import { TaskNotFoundError } from '@a2a-js/sdk/client'
import { describe, expect, it, vi } from 'vitest'

import {
  createFakeA2aTaskTracker,
  createFakeRemoteAgentRegistry,
  createInMemoryA2aTaskTracker,
  createRecordingLogger,
  createScriptedEventLogStore,
  createStubSlackClient,
  recordingHandleForGetTask,
} from '@/plugins/llm-agent/_test-utils'
import type { NewA2aTask } from '@/plugins/llm-agent/a2a-task-tracker'
import { createResponseFinalizer } from '@/plugins/llm-agent/response-finalizer'
import {
  DEADLINE_EXCEEDED_TEXT,
  startTaskReconciler,
  TASK_NOT_FOUND_TEXT,
  TASK_RECONCILER_DEFAULT_GRACE_MS,
  TASK_RECONCILER_DEFAULT_INTERVAL_MS,
  TASK_RECONCILER_DEFAULT_RETENTION_MS,
} from '@/plugins/llm-agent/task-reconciler'
import type { SlackWebClient } from '@/slack/web-client'

const NOW = new Date('2026-01-10T00:00:00Z')
// Well before NOW minus the default grace period, so findUnsettled's
// "updated before the cutoff" condition picks up rows created at this
// timestamp once the clock advances to NOW for the reconciler tick.
const CREATED_AT = new Date('2026-01-09T22:00:00Z')

const baseTask = (override: Partial<NewA2aTask> = {}): NewA2aTask => ({
  taskId: 'task-1',
  contextId: 'ctx-1',
  agentName: 'meshi',
  slackTeamId: 'T1',
  slackChannelId: 'C1',
  threadRootTs: '111.222',
  slackEventId: 'Ev1',
  state: 'working',
  deadlineAt: new Date('2026-01-10T01:00:00Z'),
  ...override,
})

describe('startTaskReconciler', () => {
  it('recovers a missed push by settling through the finalizer when polling observes a decided task', async () => {
    let clock = CREATED_AT
    const tracker = createInMemoryA2aTaskTracker({ now: () => clock })
    await tracker.recordDelegated(baseTask())
    clock = NOW
    const { handle, calls: getTaskCalls } = recordingHandleForGetTask(
      async () => ({
        kind: 'task',
        id: 'task-1',
        contextId: 'ctx-1',
        status: {
          state: 'completed',
          message: {
            kind: 'message',
            messageId: 'm1',
            role: 'agent',
            parts: [{ kind: 'text', text: 'done' }],
          },
        },
      }),
    )
    const remoteAgentRegistry = createFakeRemoteAgentRegistry([handle])
    const eventLogStore = createScriptedEventLogStore()
    const slackClient = createStubSlackClient()
    const responseFinalizer = createResponseFinalizer({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      eventLogStore,
      slackClient,
    })
    const reconciler = startTaskReconciler({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      responseFinalizer,
      eventLogStore,
      slackClient,
      now: () => clock,
      setIntervalImpl: () => ({}) as unknown as NodeJS.Timeout,
      clearIntervalImpl: () => {},
    })

    const result = await reconciler.runOnce()

    // Exactly one tasks/get call: the reconciler's own poll hands its result
    // straight to finalizeTask instead of making the finalizer re-fetch it.
    expect(getTaskCalls).toEqual(['task-1'])
    expect(slackClient.calls).toEqual([
      {
        kind: 'post',
        channel: 'C1',
        thread: '111.222',
        text: 'done',
        blocks: [{ type: 'markdown', text: 'done' }],
        loadingMessages: undefined,
      },
    ])
    expect(await tracker.findByTaskId('task-1')).toEqual({
      ...baseTask(),
      state: 'completed',
      settled: true,
      createdAt: CREATED_AT,
      updatedAt: NOW,
    })
    expect(eventLogStore.markedResponded).toEqual(['Ev1'])
    expect(result).toEqual({ settled: 1, pruned: 0 })
  })

  it('leaves a row untouched while it is still within the grace period', async () => {
    const recentlyUpdated = new Date(NOW.getTime() - 30_000)
    let clock = recentlyUpdated
    const tracker = createInMemoryA2aTaskTracker({ now: () => clock })
    await tracker.recordDelegated(baseTask())
    clock = NOW
    const { handle, calls: getTaskCalls } = recordingHandleForGetTask(
      async () => ({
        kind: 'task',
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'completed' },
      }),
    )
    const remoteAgentRegistry = createFakeRemoteAgentRegistry([handle])
    const slackClient = createStubSlackClient()
    const responseFinalizer = createResponseFinalizer({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      eventLogStore: createScriptedEventLogStore(),
      slackClient,
    })
    const reconciler = startTaskReconciler({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      responseFinalizer,
      eventLogStore: createScriptedEventLogStore(),
      slackClient,
      now: () => clock,
      graceMs: TASK_RECONCILER_DEFAULT_GRACE_MS,
      setIntervalImpl: () => ({}) as unknown as NodeJS.Timeout,
      clearIntervalImpl: () => {},
    })

    const result = await reconciler.runOnce()

    expect(getTaskCalls).toEqual([])
    expect(slackClient.calls).toEqual([])
    expect(await tracker.findByTaskId('task-1')).toEqual({
      ...baseTask(),
      settled: false,
      createdAt: recentlyUpdated,
      updatedAt: recentlyUpdated,
    })
    expect(result).toEqual({ settled: 0, pruned: 0 })
  })

  it('logs a warning and does nothing when the row references a remote agent no longer registered', async () => {
    let clock = CREATED_AT
    const tracker = createInMemoryA2aTaskTracker({ now: () => clock })
    await tracker.recordDelegated(baseTask())
    clock = NOW
    const logger = createRecordingLogger()
    const remoteAgentRegistry = createFakeRemoteAgentRegistry([])
    const responseFinalizer = createResponseFinalizer({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      eventLogStore: createScriptedEventLogStore(),
      slackClient: createStubSlackClient(),
    })
    const reconciler = startTaskReconciler({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      responseFinalizer,
      eventLogStore: createScriptedEventLogStore(),
      slackClient: createStubSlackClient(),
      now: () => clock,
      logger,
      setIntervalImpl: () => ({}) as unknown as NodeJS.Timeout,
      clearIntervalImpl: () => {},
    })

    const result = await reconciler.runOnce()

    expect(logger.entries).toEqual([
      {
        level: 'warn',
        payload: {
          event: 'llm_agent_a2a_reconcile_agent_not_found',
          task_id: 'task-1',
          agent_name: 'meshi',
        },
        message:
          'llm-agent reconciler could not poll a task: its remote agent is no longer registered',
      },
    ])
    expect(await tracker.findByTaskId('task-1')).toEqual({
      ...baseTask(),
      settled: false,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })
    expect(result).toEqual({ settled: 0, pruned: 0 })
  })

  it('fails a submitted/working task past its deadline without polling, and notifies the thread', async () => {
    let clock = CREATED_AT
    const tracker = createInMemoryA2aTaskTracker({ now: () => clock })
    await tracker.recordDelegated(
      baseTask({
        state: 'working',
        deadlineAt: new Date('2026-01-09T00:00:00Z'),
      }),
    )
    clock = NOW
    const remoteAgentRegistry = createFakeRemoteAgentRegistry([])
    const eventLogStore = createScriptedEventLogStore()
    const slackClient = createStubSlackClient()
    const responseFinalizer = createResponseFinalizer({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      eventLogStore,
      slackClient,
    })
    const reconciler = startTaskReconciler({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      responseFinalizer,
      eventLogStore,
      slackClient,
      now: () => clock,
      setIntervalImpl: () => ({}) as unknown as NodeJS.Timeout,
      clearIntervalImpl: () => {},
    })

    const result = await reconciler.runOnce()

    expect(await tracker.findByTaskId('task-1')).toEqual({
      ...baseTask({
        state: 'failed',
        deadlineAt: new Date('2026-01-09T00:00:00Z'),
      }),
      settled: true,
      createdAt: CREATED_AT,
      updatedAt: NOW,
    })
    expect(slackClient.calls).toEqual([
      {
        kind: 'post',
        channel: 'C1',
        thread: '111.222',
        text: DEADLINE_EXCEEDED_TEXT,
        blocks: [{ type: 'markdown', text: DEADLINE_EXCEEDED_TEXT }],
        loadingMessages: undefined,
      },
    ])
    expect(eventLogStore.markedResponded).toEqual(['Ev1'])
    expect(result).toEqual({ settled: 1, pruned: 0 })
  })

  it('rolls back the settled flag when the deadline-failure post fails, so a retry can post it', async () => {
    let clock = CREATED_AT
    const tracker = createInMemoryA2aTaskTracker({ now: () => clock })
    await tracker.recordDelegated(
      baseTask({
        state: 'working',
        deadlineAt: new Date('2026-01-09T00:00:00Z'),
      }),
    )
    clock = NOW
    const remoteAgentRegistry = createFakeRemoteAgentRegistry([])
    const eventLogStore = createScriptedEventLogStore()
    const failingSlackClient: SlackWebClient = {
      ...createStubSlackClient(),
      async postMessage() {
        throw new Error('rate_limited')
      },
    }
    const responseFinalizer = createResponseFinalizer({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      eventLogStore,
      slackClient: failingSlackClient,
    })
    const reconciler = startTaskReconciler({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      responseFinalizer,
      eventLogStore,
      slackClient: failingSlackClient,
      now: () => clock,
      setIntervalImpl: () => ({}) as unknown as NodeJS.Timeout,
      clearIntervalImpl: () => {},
    })

    const result = await reconciler.runOnce()

    expect(await tracker.findByTaskId('task-1')).toEqual({
      ...baseTask({
        state: 'failed',
        deadlineAt: new Date('2026-01-09T00:00:00Z'),
      }),
      settled: false,
      createdAt: CREATED_AT,
      updatedAt: NOW,
    })
    expect(eventLogStore.markedResponded).toEqual([])
    expect(result).toEqual({ settled: 1, pruned: 0 })
  })

  it('excludes an input-required task from deadline failure even past its deadline', async () => {
    let clock = CREATED_AT
    const tracker = createInMemoryA2aTaskTracker({ now: () => clock })
    await tracker.recordDelegated(
      baseTask({
        state: 'input-required',
        deadlineAt: new Date('2026-01-09T00:00:00Z'),
      }),
    )
    clock = NOW
    const { handle } = recordingHandleForGetTask(async () => ({
      kind: 'task',
      id: 'task-1',
      contextId: 'ctx-1',
      status: { state: 'input-required' },
    }))
    const remoteAgentRegistry = createFakeRemoteAgentRegistry([handle])
    const slackClient = createStubSlackClient()
    const responseFinalizer = createResponseFinalizer({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      eventLogStore: createScriptedEventLogStore(),
      slackClient,
    })
    const reconciler = startTaskReconciler({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      responseFinalizer,
      eventLogStore: createScriptedEventLogStore(),
      slackClient,
      now: () => clock,
      setIntervalImpl: () => ({}) as unknown as NodeJS.Timeout,
      clearIntervalImpl: () => {},
    })

    const result = await reconciler.runOnce()

    expect(await tracker.findByTaskId('task-1')).toEqual({
      ...baseTask({
        state: 'input-required',
        deadlineAt: new Date('2026-01-09T00:00:00Z'),
      }),
      settled: false,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })
    expect(slackClient.calls).toEqual([])
    expect(result).toEqual({ settled: 0, pruned: 0 })
  })

  it('fails a task and notifies the thread when tasks/get reports TaskNotFound', async () => {
    let clock = CREATED_AT
    const tracker = createInMemoryA2aTaskTracker({ now: () => clock })
    await tracker.recordDelegated(baseTask())
    clock = NOW
    const { handle } = recordingHandleForGetTask(async () => {
      throw new TaskNotFoundError('task-1')
    })
    const remoteAgentRegistry = createFakeRemoteAgentRegistry([handle])
    const eventLogStore = createScriptedEventLogStore()
    const slackClient = createStubSlackClient()
    const responseFinalizer = createResponseFinalizer({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      eventLogStore,
      slackClient,
    })
    const reconciler = startTaskReconciler({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      responseFinalizer,
      eventLogStore,
      slackClient,
      now: () => clock,
      setIntervalImpl: () => ({}) as unknown as NodeJS.Timeout,
      clearIntervalImpl: () => {},
    })

    const result = await reconciler.runOnce()

    expect(await tracker.findByTaskId('task-1')).toEqual({
      ...baseTask({ state: 'failed' }),
      settled: true,
      createdAt: CREATED_AT,
      updatedAt: NOW,
    })
    expect(slackClient.calls).toEqual([
      {
        kind: 'post',
        channel: 'C1',
        thread: '111.222',
        text: TASK_NOT_FOUND_TEXT,
        blocks: [{ type: 'markdown', text: TASK_NOT_FOUND_TEXT }],
        loadingMessages: undefined,
      },
    ])
    expect(eventLogStore.markedResponded).toEqual(['Ev1'])
    expect(result).toEqual({ settled: 1, pruned: 0 })
  })

  it('also fails an input-required task when tasks/get reports TaskNotFound, instead of leaving it stuck forever', async () => {
    let clock = CREATED_AT
    const tracker = createInMemoryA2aTaskTracker({ now: () => clock })
    await tracker.recordDelegated(baseTask({ state: 'input-required' }))
    clock = NOW
    const { handle } = recordingHandleForGetTask(async () => {
      throw new TaskNotFoundError('task-1')
    })
    const remoteAgentRegistry = createFakeRemoteAgentRegistry([handle])
    const eventLogStore = createScriptedEventLogStore()
    const slackClient = createStubSlackClient()
    const responseFinalizer = createResponseFinalizer({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      eventLogStore,
      slackClient,
    })
    const reconciler = startTaskReconciler({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      responseFinalizer,
      eventLogStore,
      slackClient,
      now: () => clock,
      setIntervalImpl: () => ({}) as unknown as NodeJS.Timeout,
      clearIntervalImpl: () => {},
    })

    const result = await reconciler.runOnce()

    // transitionGuard's default 'failed' guard only permits submitted/working
    // rows; without requireCurrentStates: ['input-required'] here, this row
    // would never settle and would sit unsettled (and un-pruned) forever.
    expect(await tracker.findByTaskId('task-1')).toEqual({
      ...baseTask({ state: 'failed' }),
      settled: true,
      createdAt: CREATED_AT,
      updatedAt: NOW,
    })
    expect(slackClient.calls).toEqual([
      {
        kind: 'post',
        channel: 'C1',
        thread: '111.222',
        text: TASK_NOT_FOUND_TEXT,
        blocks: [{ type: 'markdown', text: TASK_NOT_FOUND_TEXT }],
        loadingMessages: undefined,
      },
    ])
    expect(eventLogStore.markedResponded).toEqual(['Ev1'])
    expect(result).toEqual({ settled: 1, pruned: 0 })
  })

  it('prunes using a cutoff derived from retentionMs, and returns the count', async () => {
    // Row-selection semantics (settled + updatedAt cutoff) are covered by
    // a2a-task-tracker.test.ts's own deleteSettledOlderThan tests; this only
    // verifies the reconciler derives the right cutoff and threads the count
    // through, mirroring event-log-retention.test.ts's own prune-wiring test.
    const deleteSettledOlderThan = vi.fn(async (): Promise<number> => 3)
    const tracker = {
      ...createFakeA2aTaskTracker(),
      deleteSettledOlderThan,
    }
    const remoteAgentRegistry = createFakeRemoteAgentRegistry([])
    const responseFinalizer = createResponseFinalizer({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      eventLogStore: createScriptedEventLogStore(),
      slackClient: createStubSlackClient(),
    })
    const reconciler = startTaskReconciler({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      responseFinalizer,
      eventLogStore: createScriptedEventLogStore(),
      slackClient: createStubSlackClient(),
      now: () => NOW,
      retentionMs: 1000,
      setIntervalImpl: () => ({}) as unknown as NodeJS.Timeout,
      clearIntervalImpl: () => {},
    })

    const result = await reconciler.runOnce()

    expect(deleteSettledOlderThan.mock.calls).toEqual([
      [new Date(NOW.getTime() - 1000)],
    ])
    expect(result).toEqual({ settled: 0, pruned: 3 })
  })

  it('schedules ticks on the requested interval and stop clears it', () => {
    const fakeTimer = Symbol('timer') as unknown as NodeJS.Timeout
    const setIntervalImpl = vi.fn<
      (callback: () => void, ms: number) => NodeJS.Timeout
    >(() => fakeTimer)
    const clearIntervalImpl = vi.fn<(handle: NodeJS.Timeout) => void>()
    const remoteAgentRegistry = createFakeRemoteAgentRegistry([])
    const responseFinalizer = createResponseFinalizer({
      a2aTaskTracker: createFakeA2aTaskTracker(),
      remoteAgentRegistry,
      eventLogStore: createScriptedEventLogStore(),
      slackClient: createStubSlackClient(),
    })
    const reconciler = startTaskReconciler({
      a2aTaskTracker: createFakeA2aTaskTracker(),
      remoteAgentRegistry,
      responseFinalizer,
      eventLogStore: createScriptedEventLogStore(),
      slackClient: createStubSlackClient(),
      intervalMs: 12_345,
      setIntervalImpl,
      clearIntervalImpl,
    })

    expect(setIntervalImpl.mock.calls.map((args) => args[1])).toEqual([12_345])

    reconciler.stop()
    expect(clearIntervalImpl.mock.calls).toEqual([[fakeTimer]])
  })

  it('exposes default grace, interval, and retention constants used when options are omitted', () => {
    expect(TASK_RECONCILER_DEFAULT_GRACE_MS).toBe(2 * 60 * 1000)
    expect(TASK_RECONCILER_DEFAULT_INTERVAL_MS).toBe(60 * 1000)
    expect(TASK_RECONCILER_DEFAULT_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})
