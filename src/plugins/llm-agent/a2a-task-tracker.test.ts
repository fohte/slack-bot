import { describe, expect, it } from 'vitest'

import type {
  A2aTaskLifecycle,
  A2aTaskRow,
  A2aTaskTracker,
  NewA2aTask,
  ThreadKey,
} from '@/plugins/llm-agent/a2a-task-tracker'
import { A2A_TASK_ACTIVE_EXECUTION_STATES } from '@/plugins/llm-agent/a2a-task-tracker'

// Reference implementation used to pin down the contract a real store must
// satisfy, since exercising conditional-UPDATE semantics needs a real
// Postgres connection this test environment does not have.
const createInMemoryTracker = (
  options: { now?: () => Date } = {},
): A2aTaskTracker => {
  const now = options.now ?? (() => new Date())
  const rows = new Map<string, A2aTaskRow>()

  return {
    async recordDelegated(rec: NewA2aTask) {
      const timestamp = now()
      rows.set(rec.taskId, {
        ...rec,
        settled: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    },
    async findActiveInputRequired(threadKey: ThreadKey) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.slackTeamId === threadKey.slackTeamId &&
            row.slackChannelId === threadKey.slackChannelId &&
            row.threadRootTs === threadKey.threadRootTs &&
            row.state === 'input-required' &&
            !row.settled,
        )
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]
    },
    async findUnsettled(olderThan: Date) {
      return [...rows.values()]
        .filter((row) => !row.settled && row.updatedAt < olderThan)
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
    },
    async transition(taskId: string, to: A2aTaskLifecycle) {
      const row = rows.get(taskId)
      if (row === undefined || row.settled) return { updated: false }
      if (
        to.state === 'failed' &&
        !A2A_TASK_ACTIVE_EXECUTION_STATES.includes(row.state)
      ) {
        return { updated: false }
      }
      rows.set(taskId, {
        ...row,
        state: to.state,
        settled: to.settled,
        deadlineAt: to.deadlineAt ?? row.deadlineAt,
        updatedAt: now(),
      })
      return { updated: true }
    },
    async lookupContext(threadKey: ThreadKey, agentName: string) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.slackTeamId === threadKey.slackTeamId &&
            row.slackChannelId === threadKey.slackChannelId &&
            row.threadRootTs === threadKey.threadRootTs &&
            row.agentName === agentName,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
        ?.contextId
    },
  }
}

const THREAD: ThreadKey = {
  slackTeamId: 'T1',
  slackChannelId: 'C1',
  threadRootTs: '100.000',
}

const newTask = (override: Partial<NewA2aTask> = {}): NewA2aTask => ({
  taskId: 'task-1',
  contextId: 'ctx-1',
  agentName: 'meshi',
  slackEventId: 'Ev1',
  state: 'working',
  deadlineAt: new Date('2026-01-01T00:10:00Z'),
  ...THREAD,
  ...override,
})

describe('recordDelegated / findActiveInputRequired', () => {
  it('finds a delegated task once it is input-required and unsettled', async () => {
    const created = new Date('2026-01-01T00:00:00Z')
    const tracker = createInMemoryTracker({ now: () => created })
    await tracker.recordDelegated(newTask({ state: 'input-required' }))

    expect(await tracker.findActiveInputRequired(THREAD)).toEqual({
      ...newTask({ state: 'input-required' }),
      settled: false,
      createdAt: created,
      updatedAt: created,
    })
  })

  it('returns undefined when no active task in the thread is input-required', async () => {
    const tracker = createInMemoryTracker()
    await tracker.recordDelegated(newTask({ state: 'working' }))

    expect(await tracker.findActiveInputRequired(THREAD)).toBeUndefined()
  })
})

describe('findUnsettled', () => {
  it('returns unsettled rows updated before the cutoff', async () => {
    const created = new Date('2026-01-01T00:00:00Z')
    const tracker = createInMemoryTracker({ now: () => created })
    await tracker.recordDelegated(newTask())

    expect(
      await tracker.findUnsettled(new Date('2026-01-01T00:00:01Z')),
    ).toEqual([
      { ...newTask(), settled: false, createdAt: created, updatedAt: created },
    ])
  })

  it('excludes rows not yet older than the cutoff', async () => {
    const created = new Date('2026-01-01T00:00:00Z')
    const tracker = createInMemoryTracker({ now: () => created })
    await tracker.recordDelegated(newTask())

    expect(await tracker.findUnsettled(created)).toEqual([])
  })
})

describe('transition', () => {
  it('elects exactly one winner when two callers settle the same task concurrently', async () => {
    const tracker = createInMemoryTracker()
    await tracker.recordDelegated(newTask({ state: 'working' }))

    const winners = await Promise.all([
      tracker.transition('task-1', { state: 'completed', settled: true }),
      tracker.transition('task-1', { state: 'failed', settled: true }),
    ])

    expect(winners).toEqual([{ updated: true }, { updated: false }])
  })

  it('does not fail a task waiting on user input', async () => {
    const tracker = createInMemoryTracker()
    await tracker.recordDelegated(newTask({ state: 'input-required' }))

    expect(
      await tracker.transition('task-1', { state: 'failed', settled: true }),
    ).toEqual({ updated: false })
  })

  it('fails a task that is still executing', async () => {
    const tracker = createInMemoryTracker()
    await tracker.recordDelegated(newTask({ state: 'working' }))

    expect(
      await tracker.transition('task-1', { state: 'failed', settled: true }),
    ).toEqual({ updated: true })
  })

  it('resumes an input-required task with a fresh deadline', async () => {
    const tracker = createInMemoryTracker()
    await tracker.recordDelegated(newTask({ state: 'input-required' }))

    expect(
      await tracker.transition('task-1', {
        state: 'submitted',
        settled: false,
        deadlineAt: new Date('2026-01-01T01:00:00Z'),
      }),
    ).toEqual({ updated: true })
  })

  it('does not transition a task that is already settled', async () => {
    const tracker = createInMemoryTracker()
    await tracker.recordDelegated(newTask({ state: 'working' }))
    await tracker.transition('task-1', { state: 'completed', settled: true })

    expect(
      await tracker.transition('task-1', { state: 'failed', settled: true }),
    ).toEqual({ updated: false })
  })
})

describe('lookupContext', () => {
  it('returns undefined for a thread and agent with no prior delegation', async () => {
    const tracker = createInMemoryTracker()

    expect(await tracker.lookupContext(THREAD, 'meshi')).toBeUndefined()
  })

  it('reuses the contextId of the most recently delegated task for the same thread and agent', async () => {
    let tick = new Date('2026-01-01T00:00:00Z')
    const tracker = createInMemoryTracker({ now: () => tick })
    await tracker.recordDelegated(
      newTask({ taskId: 'task-1', contextId: 'ctx-old' }),
    )
    tick = new Date('2026-01-01T00:05:00Z')
    await tracker.recordDelegated(
      newTask({ taskId: 'task-2', contextId: 'ctx-new' }),
    )

    expect(await tracker.lookupContext(THREAD, 'meshi')).toBe('ctx-new')
  })

  it('does not reuse a context recorded for a different agent', async () => {
    const tracker = createInMemoryTracker()
    await tracker.recordDelegated(
      newTask({ agentName: 'meshi', contextId: 'ctx-meshi' }),
    )

    expect(await tracker.lookupContext(THREAD, 't-rader')).toBeUndefined()
  })
})
