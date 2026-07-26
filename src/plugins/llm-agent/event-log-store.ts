import { and, eq, isNotNull, lt, ne } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { ResultAsync } from 'neverthrow'

import { eventLog } from '#db/schema'
import { EventLogStoreError } from '#types/errors'

// Caps a single findDispatchedUnresponded query so a large backlog (e.g.
// during an extended outage) cannot pull an unbounded result set into
// memory; the response reconciler picks up any remainder on its next tick.
const FIND_DISPATCHED_UNRESPONDED_LIMIT = 100

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
  recordReceived(
    record: EventLogRecord,
  ): ResultAsync<EventLogOutcome, EventLogStoreError>
  deleteReceived(slackEventId: string): ResultAsync<void, EventLogStoreError>
  markTaskName(
    slackEventId: string,
    taskName: string,
  ): ResultAsync<{ updated: number }, EventLogStoreError>
  findByTaskName(
    taskName: string,
  ): ResultAsync<EventLogRow | undefined, EventLogStoreError>
  // Rows dispatched (task_name set) but not yet responded, received before
  // `receivedBefore`. Backs the response reconciler that recovers Task
  // completions a dead Pod never got to post to Slack. There is no separate
  // dispatch timestamp on this table, so this filters on `received_at`,
  // which only approximates how long a row has actually been dispatched.
  // Capped at FIND_DISPATCHED_UNRESPONDED_LIMIT rows per call; a caller that
  // needs the true backlog size must call repeatedly across ticks.
  findDispatchedUnresponded(
    receivedBefore: Date,
  ): ResultAsync<readonly EventLogRow[], EventLogStoreError>
  markResponded(
    slackEventId: string,
  ): ResultAsync<{ updated: number }, EventLogStoreError>
  unmarkResponded(
    slackEventId: string,
  ): ResultAsync<{ updated: number }, EventLogStoreError>
  pruneOlderThan(cutoff: Date): ResultAsync<number, EventLogStoreError>
  // True when another already-accepted event describes the same physical
  // Slack message (same team+channel+messageTs). Used to detect the
  // `message`/`app_mention` pair Slack sends for a single mention.
  hasAcceptedSibling(
    query: AcceptedSiblingQuery,
  ): ResultAsync<boolean, EventLogStoreError>
}

const normalize = (value: string | null): string | undefined =>
  value === null ? undefined : value

export const createEventLogStore = (db: PostgresJsDatabase): EventLogStore => ({
  recordReceived(record) {
    return ResultAsync.fromPromise(
      db
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
        .returning({ slackEventId: eventLog.slackEventId }),
      (caughtErr) =>
        new EventLogStoreError('failed to record received event', caughtErr),
    ).map((inserted) =>
      inserted.length > 0 ? 'accepted' : 'rejected_duplicate',
    )
  },
  deleteReceived(slackEventId) {
    return ResultAsync.fromPromise(
      db.delete(eventLog).where(eq(eventLog.slackEventId, slackEventId)),
      (caughtErr) =>
        new EventLogStoreError('failed to delete received event', caughtErr),
    ).map(() => undefined)
  },
  markTaskName(slackEventId, taskName) {
    return ResultAsync.fromPromise(
      db
        .update(eventLog)
        .set({ taskName })
        .where(eq(eventLog.slackEventId, slackEventId))
        .returning({ slackEventId: eventLog.slackEventId }),
      (caughtErr) =>
        new EventLogStoreError('failed to mark event task name', caughtErr),
    ).map((updated) => ({ updated: updated.length }))
  },
  findByTaskName(taskName) {
    return ResultAsync.fromPromise(
      db
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
        .limit(1),
      (caughtErr) =>
        new EventLogStoreError('failed to find event by task name', caughtErr),
    ).map((rows) => {
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
    })
  },
  findDispatchedUnresponded(receivedBefore) {
    return ResultAsync.fromPromise(
      db
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
        .limit(FIND_DISPATCHED_UNRESPONDED_LIMIT),
      (caughtErr) =>
        new EventLogStoreError(
          'failed to find dispatched unresponded events',
          caughtErr,
        ),
    ).map((rows) =>
      rows.map((row) => ({
        slackEventId: row.slackEventId,
        outcome: row.outcome,
        slackTeamId: normalize(row.slackTeamId),
        slackChannelId: normalize(row.slackChannelId),
        threadRootTs: normalize(row.threadRootTs),
        taskName: normalize(row.taskName),
      })),
    )
  },
  markResponded(slackEventId) {
    // Only transition rows that are not yet responded; the conditional
    // makes this a serialization point so concurrent watcher ticks elect a
    // single winner for the Slack post.
    return ResultAsync.fromPromise(
      db
        .update(eventLog)
        .set({ outcome: 'responded' })
        .where(
          and(
            eq(eventLog.slackEventId, slackEventId),
            ne(eventLog.outcome, 'responded'),
          ),
        )
        .returning({ slackEventId: eventLog.slackEventId }),
      (caughtErr) =>
        new EventLogStoreError('failed to mark event responded', caughtErr),
    ).map((updated) => ({ updated: updated.length }))
  },
  unmarkResponded(slackEventId) {
    return ResultAsync.fromPromise(
      db
        .update(eventLog)
        .set({ outcome: 'accepted' })
        .where(
          and(
            eq(eventLog.slackEventId, slackEventId),
            eq(eventLog.outcome, 'responded'),
          ),
        )
        .returning({ slackEventId: eventLog.slackEventId }),
      (caughtErr) =>
        new EventLogStoreError('failed to unmark event responded', caughtErr),
    ).map((updated) => ({ updated: updated.length }))
  },
  pruneOlderThan(cutoff) {
    return ResultAsync.fromPromise(
      db
        .delete(eventLog)
        .where(lt(eventLog.receivedAt, cutoff))
        .returning({ slackEventId: eventLog.slackEventId }),
      (caughtErr) =>
        new EventLogStoreError('failed to prune event_log', caughtErr),
    ).map((deleted) => deleted.length)
  },
  hasAcceptedSibling({
    slackTeamId,
    slackChannelId,
    messageTs,
    excludeSlackEventId,
  }) {
    return ResultAsync.fromPromise(
      db
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
        .limit(1),
      (caughtErr) =>
        new EventLogStoreError(
          'failed to check for an accepted sibling event',
          caughtErr,
        ),
    ).map((rows) => rows.length > 0)
  },
})
