import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

import { threadSessionMap } from '@/db/schema'

export interface ThreadSessionKey {
  readonly slackTeamId: string
  readonly slackChannelId: string
  readonly threadRootTs: string
}

export interface ThreadSessionStore {
  lookup(key: ThreadSessionKey): Promise<string | undefined>
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
})
