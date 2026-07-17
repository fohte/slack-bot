import { describe, expect, it } from 'vitest'

import { createInMemoryA2aTaskTracker as createInMemoryTracker } from '@/plugins/llm-agent/_test-utils'
import type {
  NewA2aTask,
  ThreadKey,
} from '@/plugins/llm-agent/a2a-task-tracker'
import {
  A2A_TASK_ACTIVE_EXECUTION_STATES,
  FIND_UNSETTLED_LIMIT,
  transitionGuard,
} from '@/plugins/llm-agent/a2a-task-tracker'

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

describe('transitionGuard', () => {
  it('requires the task still be actively executing when failing it', () => {
    expect(transitionGuard({ state: 'failed' })).toEqual({
      requireStates: A2A_TASK_ACTIVE_EXECUTION_STATES,
    })
  })

  it('does not restrict other transitions', () => {
    expect(transitionGuard({ state: 'completed' })).toEqual({})
  })

  it('lets a caller override the required current states', () => {
    expect(
      transitionGuard({
        state: 'failed',
        requireCurrentStates: ['input-required'],
      }),
    ).toEqual({ requireStates: ['input-required'] })
  })

  it('requires the task still be actively executing when moving it to input-required', () => {
    expect(transitionGuard({ state: 'input-required' })).toEqual({
      requireStates: A2A_TASK_ACTIVE_EXECUTION_STATES,
    })
  })
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

  it('caps the result at FIND_UNSETTLED_LIMIT, keeping the oldest rows', async () => {
    const base = new Date('2026-01-01T00:00:00Z')
    const rowAt = (i: number) => new Date(base.getTime() + i * 1000)
    let tick = base
    const tracker = createInMemoryTracker({ now: () => tick })
    const rowCount = FIND_UNSETTLED_LIMIT + 1
    for (let i = 0; i < rowCount; i++) {
      tick = rowAt(i)
      await tracker.recordDelegated(newTask({ taskId: `task-${i}` }))
    }

    const rows = await tracker.findUnsettled(rowAt(rowCount))

    expect(rows).toEqual(
      Array.from({ length: FIND_UNSETTLED_LIMIT }, (_, i) => ({
        ...newTask({ taskId: `task-${i}` }),
        settled: false,
        createdAt: rowAt(i),
        updatedAt: rowAt(i),
      })),
    )
  })
})

describe('transition', () => {
  it('lets only one of two racing settle attempts succeed', async () => {
    const tracker = createInMemoryTracker()
    await tracker.recordDelegated(newTask({ state: 'working' }))

    // The in-memory fake's transition has no internal await, so this pins
    // the settled-guard's outcome (one winner, one updated:false) rather
    // than true thread-level concurrency — a real Postgres UPDATE gets the
    // same outcome via row locks instead.
    const winners = await Promise.all([
      tracker.transition('task-1', { state: 'completed' }),
      tracker.transition('task-1', { state: 'failed' }),
    ])

    expect(winners).toEqual([{ updated: true }, { updated: false }])
  })

  it('does not fail a task waiting on user input', async () => {
    const tracker = createInMemoryTracker()
    await tracker.recordDelegated(newTask({ state: 'input-required' }))

    expect(await tracker.transition('task-1', { state: 'failed' })).toEqual({
      updated: false,
    })
  })

  it('fails a task that is still executing', async () => {
    const tracker = createInMemoryTracker()
    await tracker.recordDelegated(newTask({ state: 'working' }))

    expect(await tracker.transition('task-1', { state: 'failed' })).toEqual({
      updated: true,
    })
  })

  it('does not fail a task whose deadline has since moved past a stale snapshot', async () => {
    const tracker = createInMemoryTracker()
    const staleDeadline = new Date('2026-01-01T00:10:00Z')
    await tracker.recordDelegated(
      newTask({ state: 'working', deadlineAt: staleDeadline }),
    )
    // A resume (or any deadline rearm) after the caller took its snapshot.
    await tracker.transition('task-1', {
      state: 'working',
      deadlineAt: new Date('2026-01-01T01:00:00Z'),
    })

    expect(
      await tracker.transition('task-1', {
        state: 'failed',
        ifDeadlineAtOrBefore: staleDeadline,
      }),
    ).toEqual({ updated: false })
  })

  it('fails a task whose deadline is still at or before the observed snapshot', async () => {
    const tracker = createInMemoryTracker()
    const deadline = new Date('2026-01-01T00:10:00Z')
    await tracker.recordDelegated(
      newTask({ state: 'working', deadlineAt: deadline }),
    )

    expect(
      await tracker.transition('task-1', {
        state: 'failed',
        ifDeadlineAtOrBefore: deadline,
      }),
    ).toEqual({ updated: true })
  })

  it('resumes an input-required task by arming a fresh deadline', async () => {
    const created = new Date('2026-01-01T00:00:00Z')
    const resumedAt = new Date('2026-01-01T00:05:00Z')
    let tick = created
    const tracker = createInMemoryTracker({ now: () => tick })
    await tracker.recordDelegated(newTask({ state: 'input-required' }))

    tick = resumedAt
    const newDeadline = new Date('2026-01-01T01:00:00Z')
    await tracker.transition('task-1', {
      state: 'submitted',
      deadlineAt: newDeadline,
    })

    expect(
      await tracker.findUnsettled(new Date('2026-01-01T02:00:00Z')),
    ).toEqual([
      {
        ...newTask({ state: 'submitted', deadlineAt: newDeadline }),
        settled: false,
        createdAt: created,
        updatedAt: resumedAt,
      },
    ])
  })

  it('settles an input-required task directly when requireCurrentStates permits it', async () => {
    const tracker = createInMemoryTracker()
    await tracker.recordDelegated(newTask({ state: 'input-required' }))

    expect(
      await tracker.transition('task-1', {
        state: 'failed',
        requireCurrentStates: ['input-required'],
      }),
    ).toEqual({ updated: true })
    expect(await tracker.findActiveInputRequired(THREAD)).toBeUndefined()
  })

  it('does not transition a task that is already settled', async () => {
    const tracker = createInMemoryTracker()
    await tracker.recordDelegated(newTask({ state: 'working' }))
    await tracker.transition('task-1', { state: 'completed' })

    expect(await tracker.transition('task-1', { state: 'failed' })).toEqual({
      updated: false,
    })
  })

  it('lets only one of two racing input-required observations succeed', async () => {
    const tracker = createInMemoryTracker()
    await tracker.recordDelegated(newTask({ state: 'working' }))

    // Mirrors the "lets only one of two racing settle attempts succeed" test
    // above, but for input-required, which never sets `settled` and so
    // relies on transitionGuard's active-execution requirement instead of
    // the settled flag to elect a single winner.
    const winners = await Promise.all([
      tracker.transition('task-1', { state: 'input-required' }),
      tracker.transition('task-1', { state: 'input-required' }),
    ])

    expect(winners).toEqual([{ updated: true }, { updated: false }])
  })
})

describe('findByTaskId', () => {
  it('returns the row for a known taskId', async () => {
    const created = new Date('2026-01-01T00:00:00Z')
    const tracker = createInMemoryTracker({ now: () => created })
    await tracker.recordDelegated(newTask())

    expect(await tracker.findByTaskId('task-1')).toEqual({
      ...newTask(),
      settled: false,
      createdAt: created,
      updatedAt: created,
    })
  })

  it('returns undefined for an untracked taskId', async () => {
    const tracker = createInMemoryTracker()

    expect(await tracker.findByTaskId('unknown-task')).toBeUndefined()
  })
})

describe('unsettle', () => {
  it('reverts a settled row back to unsettled so it is picked up again', async () => {
    const created = new Date('2026-01-01T00:00:00Z')
    const settledAt = new Date('2026-01-01T00:05:00Z')
    const unsettledAt = new Date('2026-01-01T00:06:00Z')
    let tick = created
    const tracker = createInMemoryTracker({ now: () => tick })
    await tracker.recordDelegated(newTask({ state: 'working' }))

    tick = settledAt
    await tracker.transition('task-1', { state: 'completed' })

    tick = unsettledAt
    expect(await tracker.unsettle('task-1')).toEqual({ updated: true })
    expect(
      await tracker.findUnsettled(new Date('2026-01-01T01:00:00Z')),
    ).toEqual([
      {
        ...newTask({ state: 'completed' }),
        settled: false,
        createdAt: created,
        updatedAt: unsettledAt,
      },
    ])
  })

  it('is a no-op for a row that is not settled', async () => {
    const tracker = createInMemoryTracker()
    await tracker.recordDelegated(newTask({ state: 'working' }))

    expect(await tracker.unsettle('task-1')).toEqual({ updated: false })
  })

  it('is a no-op for an untracked taskId', async () => {
    const tracker = createInMemoryTracker()

    expect(await tracker.unsettle('unknown-task')).toEqual({ updated: false })
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
