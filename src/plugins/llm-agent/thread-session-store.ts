import { and, eq, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

import { threadSessionMap } from '@/db/schema'

export interface ThreadSessionKey {
  readonly slackTeamId: string
  readonly slackChannelId: string
  readonly threadRootTs: string
}

export interface ThreadSessionUpsert extends ThreadSessionKey {
  readonly opencodeSessionId: string
}

export interface ThreadSessionStore {
  lookup(key: ThreadSessionKey): Promise<string | undefined>
  upsert(record: ThreadSessionUpsert): Promise<void>
}

export const createThreadSessionStore = (
  db: PostgresJsDatabase,
): ThreadSessionStore => ({
  async lookup(key) {
    const rows = await db
      .select({ opencodeSessionId: threadSessionMap.opencodeSessionId })
      .from(threadSessionMap)
      .where(
        and(
          eq(threadSessionMap.slackTeamId, key.slackTeamId),
          eq(threadSessionMap.slackChannelId, key.slackChannelId),
          eq(threadSessionMap.threadRootTs, key.threadRootTs),
        ),
      )
      .limit(1)
    return rows[0]?.opencodeSessionId
  },
  async upsert(record) {
    await db
      .insert(threadSessionMap)
      .values({
        slackTeamId: record.slackTeamId,
        slackChannelId: record.slackChannelId,
        threadRootTs: record.threadRootTs,
        opencodeSessionId: record.opencodeSessionId,
      })
      .onConflictDoUpdate({
        target: [
          threadSessionMap.slackTeamId,
          threadSessionMap.slackChannelId,
          threadSessionMap.threadRootTs,
        ],
        set: {
          opencodeSessionId: record.opencodeSessionId,
          updatedAt: sql`now()`,
        },
      })
  },
})
