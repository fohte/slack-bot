import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

import { a2aTask } from '@/db/schema'

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

const isA2aTaskState = (value: string): value is A2aTaskState =>
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
  readonly settled: boolean
  // Set when resuming an input-required task, to arm a fresh deadline for
  // the resumed execution. Omitted otherwise, leaving the row's deadline
  // untouched.
  readonly deadlineAt?: Date | undefined
}

export interface A2aTaskTracker {
  recordDelegated(rec: NewA2aTask): Promise<void>
  // Gates whether the next user message in a thread resumes a task instead
  // of starting a new conversation turn.
  findActiveInputRequired(threadKey: ThreadKey): Promise<A2aTaskRow | undefined>
  // Rows the reconciler should poll tasks/get for, last updated before
  // `olderThan`.
  findUnsettled(olderThan: Date): Promise<readonly A2aTaskRow[]>
  // Conditional UPDATE: only rows not yet settled are affected, so
  // concurrent callers (push notification vs. reconciler) settling the same
  // task elect a single winner.
  transition(
    taskId: string,
    to: A2aTaskLifecycle,
  ): Promise<{ updated: boolean }>
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
    await db.insert(a2aTask).values({
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
    return rows.map(toRow)
  },
  async transition(taskId, to) {
    const conditions = [eq(a2aTask.taskId, taskId), eq(a2aTask.settled, false)]
    if (to.state === 'failed') {
      conditions.push(inArray(a2aTask.state, A2A_TASK_ACTIVE_EXECUTION_STATES))
    }
    const updated = await db
      .update(a2aTask)
      .set({
        state: to.state,
        settled: to.settled,
        ...(to.deadlineAt !== undefined ? { deadlineAt: to.deadlineAt } : {}),
        updatedAt: sql`now()`,
      })
      .where(and(...conditions))
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
