import { and, desc, eq, inArray, lt, lte, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

import { a2aTask } from '@/db/schema'

// Caps a single findUnsettled query so a large backlog (e.g. during an
// extended reconciler outage) cannot pull an unbounded result set into
// memory; the reconciler picks up any remainder on its next tick.
export const FIND_UNSETTLED_LIMIT = 100

const A2A_TASK_STATES = [
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
  'rejected',
] as const

export type A2aTaskState = (typeof A2A_TASK_STATES)[number]

// Exported so callers outside this module (e.g. the delegation tool mapping
// an A2A SDK TaskState into a row) can narrow an SDK-supplied state string
// without duplicating A2A_TASK_STATES.
export const isA2aTaskState = (value: string): value is A2aTaskState =>
  (A2A_TASK_STATES as readonly string[]).includes(value)

const toA2aTaskState = (value: string): A2aTaskState => {
  if (isA2aTaskState(value)) return value
  throw new Error(`unexpected a2a_task.state value: ${value}`)
}

// States in which a task may still be actively executing. A transition to
// `failed` only applies to rows still in one of these — this is what stops a
// deadline sweep from failing a task that is legitimately waiting on the
// user (input-required).
export const A2A_TASK_ACTIVE_EXECUTION_STATES: readonly A2aTaskState[] = [
  'submitted',
  'working',
]

// `settled` is derived from `state` rather than accepted as separate input,
// so a caller can't produce an inconsistent pair (e.g. completed + unsettled)
// that would leave a finished task looping in the reconciler's sweep.
export const A2A_TASK_TERMINAL_STATES: readonly A2aTaskState[] = [
  'completed',
  'failed',
  'canceled',
  'rejected',
]

const isTerminalState = (state: A2aTaskState): boolean =>
  A2A_TASK_TERMINAL_STATES.includes(state)

export interface ThreadKey {
  readonly slackTeamId: string
  readonly slackChannelId: string
  readonly threadRootTs: string
}

export interface NewA2aTask extends ThreadKey {
  readonly taskId: string
  readonly contextId: string
  readonly agentName: string
  readonly slackEventId: string
  readonly state: A2aTaskState
  readonly deadlineAt: Date
}

export interface A2aTaskRow extends NewA2aTask {
  readonly settled: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface A2aTaskLifecycle {
  readonly state: A2aTaskState
  // Set when resuming an input-required task, to arm a fresh deadline for
  // the resumed execution. Omitted otherwise, leaving the row's deadline
  // untouched.
  readonly deadlineAt?: Date | undefined
  // Guards a deadline-driven failure: the transition only applies while the
  // row's current deadlineAt is still at or before this value, so a resume
  // that armed a later deadline after the caller observed this task as
  // overdue is not clobbered by a stale decision.
  readonly ifDeadlineAtOrBefore?: Date | undefined
  // Overrides transitionGuard's default state requirement for this call.
  // The resume flow uses this to settle an input-required row directly
  // (e.g. to 'failed' when the remote task is gone or already terminal),
  // which the default 'failed' guard below would otherwise block since
  // input-required is not an active-execution state.
  readonly requireCurrentStates?: readonly A2aTaskState[] | undefined
}

export interface TransitionGuard {
  readonly requireStates?: readonly A2aTaskState[]
}

// Which extra WHERE condition a transition needs, kept as a pure function
// separate from the SQL/in-memory execution so it is directly testable and
// shared between the production store and its test double.
//
// Transitioning into 'input-required' gets the same active-execution guard
// as 'failed': without it, two concurrent observations of the same
// input-required task (e.g. a push notification racing a reconciler poll)
// would both succeed, since input-required never sets `settled` and so
// can't rely on that flag to elect a single winner the way a terminal
// transition does.
export const transitionGuard = (to: A2aTaskLifecycle): TransitionGuard =>
  to.requireCurrentStates !== undefined
    ? { requireStates: to.requireCurrentStates }
    : to.state === 'failed' || to.state === 'input-required'
      ? { requireStates: A2A_TASK_ACTIVE_EXECUTION_STATES }
      : {}

export interface A2aTaskTracker {
  recordDelegated(rec: NewA2aTask): Promise<void>
  // Gates whether the next user message in a thread resumes a task instead
  // of starting a new conversation turn.
  findActiveInputRequired(threadKey: ThreadKey): Promise<A2aTaskRow | undefined>
  // Rows the reconciler should poll tasks/get for, last updated before
  // `olderThan`. Capped at FIND_UNSETTLED_LIMIT rows per call; a caller that
  // needs the true backlog size must call repeatedly across ticks.
  findUnsettled(olderThan: Date): Promise<readonly A2aTaskRow[]>
  // Looks up a single row by its A2A taskId. Used by the push notification
  // endpoint, which is handed only a taskId (unlike the reconciler, whose
  // findUnsettled() rows already carry every field a settle decision needs).
  findByTaskId(taskId: string): Promise<A2aTaskRow | undefined>
  // Conditional UPDATE: only rows not yet settled are affected, so
  // concurrent callers (push notification vs. reconciler) settling the same
  // task elect a single winner.
  transition(
    taskId: string,
    to: A2aTaskLifecycle,
  ): Promise<{ updated: boolean }>
  // Reverts a winning transition's settled flag after the Slack post it
  // gated failed, so the row is picked up again (by a later push or the
  // reconciler) instead of sitting settled with no post ever delivered.
  unsettle(taskId: string): Promise<{ updated: boolean }>
  // contextId reuse for a thread/agent pair; undefined means this is the
  // first delegation from this thread to this agent.
  lookupContext(
    threadKey: ThreadKey,
    agentName: string,
  ): Promise<string | undefined>
}

const ROW_COLUMNS = {
  taskId: a2aTask.taskId,
  contextId: a2aTask.contextId,
  agentName: a2aTask.agentName,
  slackTeamId: a2aTask.slackTeamId,
  slackChannelId: a2aTask.slackChannelId,
  threadRootTs: a2aTask.threadRootTs,
  slackEventId: a2aTask.slackEventId,
  state: a2aTask.state,
  settled: a2aTask.settled,
  deadlineAt: a2aTask.deadlineAt,
  createdAt: a2aTask.createdAt,
  updatedAt: a2aTask.updatedAt,
}

interface A2aTaskDbRow {
  readonly taskId: string
  readonly contextId: string
  readonly agentName: string
  readonly slackTeamId: string
  readonly slackChannelId: string
  readonly threadRootTs: string
  readonly slackEventId: string
  readonly state: string
  readonly settled: boolean
  readonly deadlineAt: Date
  readonly createdAt: Date
  readonly updatedAt: Date
}

const toRow = (row: A2aTaskDbRow): A2aTaskRow => ({
  ...row,
  state: toA2aTaskState(row.state),
})

export const createA2aTaskTracker = (
  db: PostgresJsDatabase,
): A2aTaskTracker => ({
  async recordDelegated(rec) {
    await db
      .insert(a2aTask)
      .values({
        taskId: rec.taskId,
        contextId: rec.contextId,
        agentName: rec.agentName,
        slackTeamId: rec.slackTeamId,
        slackChannelId: rec.slackChannelId,
        threadRootTs: rec.threadRootTs,
        slackEventId: rec.slackEventId,
        state: rec.state,
        deadlineAt: rec.deadlineAt,
      })
      .onConflictDoNothing({ target: a2aTask.taskId })
  },
  async findActiveInputRequired(threadKey) {
    const rows = await db
      .select(ROW_COLUMNS)
      .from(a2aTask)
      .where(
        and(
          eq(a2aTask.slackTeamId, threadKey.slackTeamId),
          eq(a2aTask.slackChannelId, threadKey.slackChannelId),
          eq(a2aTask.threadRootTs, threadKey.threadRootTs),
          eq(a2aTask.state, 'input-required'),
          eq(a2aTask.settled, false),
        ),
      )
      .orderBy(desc(a2aTask.updatedAt))
      .limit(1)
    const row = rows[0]
    return row === undefined ? undefined : toRow(row)
  },
  async findUnsettled(olderThan) {
    const rows = await db
      .select(ROW_COLUMNS)
      .from(a2aTask)
      .where(and(eq(a2aTask.settled, false), lt(a2aTask.updatedAt, olderThan)))
      .orderBy(a2aTask.updatedAt)
      .limit(FIND_UNSETTLED_LIMIT)
    return rows.map(toRow)
  },
  async findByTaskId(taskId) {
    const rows = await db
      .select(ROW_COLUMNS)
      .from(a2aTask)
      .where(eq(a2aTask.taskId, taskId))
      .limit(1)
    const row = rows[0]
    return row === undefined ? undefined : toRow(row)
  },
  async transition(taskId, to) {
    const guard = transitionGuard(to)
    const conditions = [eq(a2aTask.taskId, taskId), eq(a2aTask.settled, false)]
    if (guard.requireStates !== undefined) {
      conditions.push(inArray(a2aTask.state, guard.requireStates))
    }
    if (to.ifDeadlineAtOrBefore !== undefined) {
      conditions.push(lte(a2aTask.deadlineAt, to.ifDeadlineAtOrBefore))
    }
    const updated = await db
      .update(a2aTask)
      .set({
        state: to.state,
        settled: isTerminalState(to.state),
        ...(to.deadlineAt !== undefined ? { deadlineAt: to.deadlineAt } : {}),
        updatedAt: sql`now()`,
      })
      .where(and(...conditions))
      .returning({ taskId: a2aTask.taskId })
    return { updated: updated.length > 0 }
  },
  async unsettle(taskId) {
    const updated = await db
      .update(a2aTask)
      .set({ settled: false, updatedAt: sql`now()` })
      .where(and(eq(a2aTask.taskId, taskId), eq(a2aTask.settled, true)))
      .returning({ taskId: a2aTask.taskId })
    return { updated: updated.length > 0 }
  },
  async lookupContext(threadKey, agentName) {
    const rows = await db
      .select({ contextId: a2aTask.contextId })
      .from(a2aTask)
      .where(
        and(
          eq(a2aTask.slackTeamId, threadKey.slackTeamId),
          eq(a2aTask.slackChannelId, threadKey.slackChannelId),
          eq(a2aTask.threadRootTs, threadKey.threadRootTs),
          eq(a2aTask.agentName, agentName),
        ),
      )
      .orderBy(desc(a2aTask.createdAt))
      .limit(1)
    return rows[0]?.contextId
  },
})
