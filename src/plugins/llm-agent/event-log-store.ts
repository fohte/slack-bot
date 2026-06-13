import { and, eq, lt, ne } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

import { eventLog } from '@/db/schema'

export type EventLogOutcome = 'accepted' | 'rejected_duplicate' | 'responded'

export interface EventLogRecord {
  readonly slackEventId: string
  readonly slackTeamId?: string | undefined
  readonly slackChannelId?: string | undefined
  readonly threadRootTs?: string | undefined
}

export interface EventLogRow {
  readonly slackEventId: string
  readonly outcome: string
  readonly slackTeamId: string | undefined
  readonly slackChannelId: string | undefined
  readonly threadRootTs: string | undefined
  readonly taskName: string | undefined
}

export interface EventLogStore {
  recordReceived(record: EventLogRecord): Promise<EventLogOutcome>
  deleteReceived(slackEventId: string): Promise<void>
  markTaskName(
    slackEventId: string,
    taskName: string,
  ): Promise<{ updated: number }>
  findByTaskName(taskName: string): Promise<EventLogRow | undefined>
  markResponded(slackEventId: string): Promise<{ updated: number }>
  unmarkResponded(slackEventId: string): Promise<{ updated: number }>
  pruneOlderThan(cutoff: Date): Promise<number>
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
})
