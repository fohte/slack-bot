import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

import { eventLog } from '@/db/schema'

export type EventLogOutcome = 'accepted' | 'rejected_duplicate'

export interface EventLogRecord {
  readonly slackEventId: string
  readonly slackTeamId?: string | undefined
  readonly slackChannelId?: string | undefined
  readonly threadRootTs?: string | undefined
  readonly taskName?: string | undefined
}

export interface EventLogStore {
  recordReceived(record: EventLogRecord): Promise<EventLogOutcome>
  deleteReceived(slackEventId: string): Promise<void>
}

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
        taskName: record.taskName ?? null,
      })
      .onConflictDoNothing({ target: eventLog.slackEventId })
      .returning({ slackEventId: eventLog.slackEventId })
    return inserted.length > 0 ? 'accepted' : 'rejected_duplicate'
  },
  async deleteReceived(slackEventId) {
    await db.delete(eventLog).where(eq(eventLog.slackEventId, slackEventId))
  },
})
