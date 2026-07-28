import { and, eq, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { ResultAsync } from 'neverthrow'

import { conversationThread } from '#db/schema'
import type { ThreadKey } from '#plugins/llm-agent/a2a-task-tracker'
import { ConversationThreadStoreError } from '#types/errors'

export interface ConversationThreadRow extends ThreadKey {
  readonly createdAt: Date
  readonly lastActivityAt: Date
}

export interface ConversationThreadStore {
  // Upsert marking the bot as having accepted an event in this thread.
  // Called for every gate acceptance regardless of reason, so a later
  // mention-less reply in the same thread can be gated in even if the turn
  // that first touched it crashed before completing.
  recordActivity(
    threadKey: ThreadKey,
  ): ResultAsync<void, ConversationThreadStoreError>
  // Gates whether a mention-less message in a thread the bot has never
  // participated in should still be accepted.
  find(
    threadKey: ThreadKey,
  ): ResultAsync<
    ConversationThreadRow | undefined,
    ConversationThreadStoreError
  >
}

export const createConversationThreadStore = (
  db: PostgresJsDatabase,
): ConversationThreadStore => ({
  recordActivity(threadKey) {
    return ResultAsync.fromPromise(
      db
        .insert(conversationThread)
        .values({
          slackTeamId: threadKey.slackTeamId,
          slackChannelId: threadKey.slackChannelId,
          threadRootTs: threadKey.threadRootTs,
        })
        .onConflictDoUpdate({
          target: [
            conversationThread.slackTeamId,
            conversationThread.slackChannelId,
            conversationThread.threadRootTs,
          ],
          set: { lastActivityAt: sql`now()` },
        }),
      (caughtErr) =>
        new ConversationThreadStoreError(
          'failed to record conversation thread activity',
          caughtErr,
        ),
    ).map(() => undefined)
  },
  find(threadKey) {
    return ResultAsync.fromPromise(
      db
        .select({
          slackTeamId: conversationThread.slackTeamId,
          slackChannelId: conversationThread.slackChannelId,
          threadRootTs: conversationThread.threadRootTs,
          createdAt: conversationThread.createdAt,
          lastActivityAt: conversationThread.lastActivityAt,
        })
        .from(conversationThread)
        .where(
          and(
            eq(conversationThread.slackTeamId, threadKey.slackTeamId),
            eq(conversationThread.slackChannelId, threadKey.slackChannelId),
            eq(conversationThread.threadRootTs, threadKey.threadRootTs),
          ),
        )
        .limit(1),
      (caughtErr) =>
        new ConversationThreadStoreError(
          'failed to find conversation thread',
          caughtErr,
        ),
    ).map((rows) => rows[0])
  },
})
