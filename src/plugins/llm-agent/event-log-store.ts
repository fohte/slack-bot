import { and, eq, isNotNull, lt, ne } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

import { eventLog } from '@/db/schema'

export type EventLogOutcome = 'accepted' | 'rejected_duplicate' | 'responded'

export interface EventLogRecord {
  readonly slackEventId: string
  readonly slackTeamId?: string | undefined
  readonly slackChannelId?: string | undefined
  readonly threadRootTs?: string | undefined
  readonly messageTs?: string | undefined
}

export interface EventLogRow {
  readonly slackEventId: string
  readonly outcome: string
  readonly slackTeamId: string | undefined
  readonly slackChannelId: string | undefined
  readonly threadRootTs: string | undefined
  readonly taskName: string | undefined
}

export interface AcceptedSiblingQuery {
  readonly slackTeamId: string
  readonly slackChannelId: string
  readonly messageTs: string
  readonly excludeSlackEventId: string
}

export interface EventLogStore {
  recordReceived(record: EventLogRecord): Promise<EventLogOutcome>
  deleteReceived(slackEventId: string): Promise<void>
  markTaskName(
    slackEventId: string,
    taskName: string,
  ): Promise<{ updated: number }>
  findByTaskName(taskName: string): Promise<EventLogRow | undefined>
  // Rows dispatched (task_name set) but not yet responded, received before
  // `receivedBefore`. Backs the response reconciler that recovers Task
  // completions a dead Pod never got to post to Slack. There is no separate
  // dispatch timestamp on this table, so this filters on `received_at`,
  // which only approximates how long a row has actually been dispatched.
  findDispatchedUnresponded(
    receivedBefore: Date,
  ): Promise<readonly EventLogRow[]>
  markResponded(slackEventId: string): Promise<{ updated: number }>
  unmarkResponded(slackEventId: string): Promise<{ updated: number }>
  pruneOlderThan(cutoff: Date): Promise<number>
  // True when another already-accepted event describes the same physical
  // Slack message (same team+channel+messageTs). Used to detect the
  // `message`/`app_mention` pair Slack sends for a single mention.
  hasAcceptedSibling(query: AcceptedSiblingQuery): Promise<boolean>
}

const normalize = (value: string | null): string | undefined =>
  value === null ? undefined : value

export const createEventLogStore = (db: PostgresJsDatabase): EventLogStore => ({
  async recordReceived(record) {
    const inserted = await db
      .insert(eventLog)
      .values({
        slackEventId: record.slackEventId,
        outcome: 'accepted',
        slackTeamId: record.slackTeamId ?? null,
        slackChannelId: record.slackChannelId ?? null,
        threadRootTs: record.threadRootTs ?? null,
        messageTs: record.messageTs ?? null,
      })
      .onConflictDoNothing({ target: eventLog.slackEventId })
      .returning({ slackEventId: eventLog.slackEventId })
    return inserted.length > 0 ? 'accepted' : 'rejected_duplicate'
  },
  async deleteReceived(slackEventId) {
    await db.delete(eventLog).where(eq(eventLog.slackEventId, slackEventId))
  },
  async markTaskName(slackEventId, taskName) {
    const updated = await db
      .update(eventLog)
      .set({ taskName })
      .where(eq(eventLog.slackEventId, slackEventId))
      .returning({ slackEventId: eventLog.slackEventId })
    return { updated: updated.length }
  },
  async findByTaskName(taskName) {
    const rows = await db
      .select({
        slackEventId: eventLog.slackEventId,
        outcome: eventLog.outcome,
        slackTeamId: eventLog.slackTeamId,
        slackChannelId: eventLog.slackChannelId,
        threadRootTs: eventLog.threadRootTs,
        taskName: eventLog.taskName,
      })
      .from(eventLog)
      .where(eq(eventLog.taskName, taskName))
      .orderBy(eventLog.receivedAt)
      .limit(1)
    const row = rows[0]
    if (row === undefined) return undefined
    return {
      slackEventId: row.slackEventId,
      outcome: row.outcome,
      slackTeamId: normalize(row.slackTeamId),
      slackChannelId: normalize(row.slackChannelId),
      threadRootTs: normalize(row.threadRootTs),
      taskName: normalize(row.taskName),
    }
  },
  async findDispatchedUnresponded(receivedBefore) {
    const rows = await db
      .select({
        slackEventId: eventLog.slackEventId,
        outcome: eventLog.outcome,
        slackTeamId: eventLog.slackTeamId,
        slackChannelId: eventLog.slackChannelId,
        threadRootTs: eventLog.threadRootTs,
        taskName: eventLog.taskName,
      })
      .from(eventLog)
      .where(
        and(
          isNotNull(eventLog.taskName),
          ne(eventLog.outcome, 'responded'),
          lt(eventLog.receivedAt, receivedBefore),
        ),
      )
      .orderBy(eventLog.receivedAt)
    return rows.map((row) => ({
      slackEventId: row.slackEventId,
      outcome: row.outcome,
      slackTeamId: normalize(row.slackTeamId),
      slackChannelId: normalize(row.slackChannelId),
      threadRootTs: normalize(row.threadRootTs),
      taskName: normalize(row.taskName),
    }))
  },
  async markResponded(slackEventId) {
    // Only transition rows that are not yet responded; the conditional
    // makes this a serialization point so concurrent watcher ticks elect a
    // single winner for the Slack post.
    const updated = await db
      .update(eventLog)
      .set({ outcome: 'responded' })
      .where(
        and(
          eq(eventLog.slackEventId, slackEventId),
          ne(eventLog.outcome, 'responded'),
        ),
      )
      .returning({ slackEventId: eventLog.slackEventId })
    return { updated: updated.length }
  },
  async unmarkResponded(slackEventId) {
    const updated = await db
      .update(eventLog)
      .set({ outcome: 'accepted' })
      .where(
        and(
          eq(eventLog.slackEventId, slackEventId),
          eq(eventLog.outcome, 'responded'),
        ),
      )
      .returning({ slackEventId: eventLog.slackEventId })
    return { updated: updated.length }
  },
  async pruneOlderThan(cutoff) {
    const deleted = await db
      .delete(eventLog)
      .where(lt(eventLog.receivedAt, cutoff))
      .returning({ slackEventId: eventLog.slackEventId })
    return deleted.length
  },
  async hasAcceptedSibling({
    slackTeamId,
    slackChannelId,
    messageTs,
    excludeSlackEventId,
  }) {
    const rows = await db
      .select({ slackEventId: eventLog.slackEventId })
      .from(eventLog)
      .where(
        and(
          eq(eventLog.slackTeamId, slackTeamId),
          eq(eventLog.slackChannelId, slackChannelId),
          eq(eventLog.messageTs, messageTs),
          ne(eventLog.slackEventId, excludeSlackEventId),
        ),
      )
      .limit(1)
    return rows.length > 0
  },
})
