import { and, eq, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { ResultAsync } from 'neverthrow'

import { threadSessionMap } from '@/db/schema'
import { ThreadSessionStoreError } from '@/types/errors'

export interface ThreadSessionKey {
  readonly slackTeamId: string
  readonly slackChannelId: string
  readonly threadRootTs: string
}

export interface ThreadSessionUpsert extends ThreadSessionKey {
  readonly opencodeSessionId: string
}

export interface ThreadSessionStore {
  lookup(
    key: ThreadSessionKey,
  ): ResultAsync<string | undefined, ThreadSessionStoreError>
  upsert(
    record: ThreadSessionUpsert,
  ): ResultAsync<void, ThreadSessionStoreError>
}

export const createThreadSessionStore = (
  db: PostgresJsDatabase,
): ThreadSessionStore => ({
  lookup(key) {
    return ResultAsync.fromPromise(
      db
        .select({ opencodeSessionId: threadSessionMap.opencodeSessionId })
        .from(threadSessionMap)
        .where(
          and(
            eq(threadSessionMap.slackTeamId, key.slackTeamId),
            eq(threadSessionMap.slackChannelId, key.slackChannelId),
            eq(threadSessionMap.threadRootTs, key.threadRootTs),
          ),
        )
        .limit(1),
      (caughtErr) =>
        new ThreadSessionStoreError(
          'failed to look up thread session',
          caughtErr,
        ),
    ).map((rows) => rows[0]?.opencodeSessionId)
  },
  upsert(record) {
    return ResultAsync.fromPromise(
      db
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
        }),
      (caughtErr) =>
        new ThreadSessionStoreError(
          'failed to upsert thread session',
          caughtErr,
        ),
    ).map(() => undefined)
  },
})
