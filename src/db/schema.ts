import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

export const eventLog = pgTable(
  'event_log',
  {
    slackEventId: text('slack_event_id').primaryKey(),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    outcome: text('outcome').notNull(),
    slackTeamId: text('slack_team_id'),
    slackChannelId: text('slack_channel_id'),
    threadRootTs: text('thread_root_ts'),
    taskName: text('task_name'),
    // The Slack message's own `ts` (not the thread root). Slack delivers a
    // `message` and an `app_mention` event for the same physical message
    // sharing this value, which is what lets the gating logic in
    // src/plugins/llm-agent/plugin.ts correlate the two deliveries.
    messageTs: text('message_ts'),
  },
  (table) => [
    index('event_log_received_idx').on(table.receivedAt),
    index('event_log_message_lookup_idx').on(
      table.slackChannelId,
      table.messageTs,
      table.slackTeamId,
    ),
  ],
)

export const a2aTask = pgTable(
  'a2a_task',
  {
    taskId: text('task_id').primaryKey(),
    contextId: text('context_id').notNull(),
    agentName: text('agent_name').notNull(),
    slackTeamId: text('slack_team_id').notNull(),
    slackChannelId: text('slack_channel_id').notNull(),
    threadRootTs: text('thread_root_ts').notNull(),
    // Reference to event_log, kept unenforced (no FK) since the two tables
    // have independent retention cycles.
    slackEventId: text('slack_event_id').notNull(),
    state: text('state').notNull(),
    settled: boolean('settled').notNull().default(false),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('a2a_task_thread_idx').on(
      table.slackTeamId,
      table.slackChannelId,
      table.threadRootTs,
    ),
    // Partial: every reader of this index (findUnsettled, transition,
    // findActiveInputRequired) filters on settled = false, and settled rows
    // never get looked up by it again.
    index('a2a_task_unsettled_idx')
      .on(table.updatedAt)
      .where(sql`${table.settled} = false`),
    // Mirrors a2a_task_unsettled_idx for the opposite side: deleteSettledOlderThan
    // filters on settled = true, and the two conditions never overlap.
    index('a2a_task_settled_idx')
      .on(table.updatedAt)
      .where(sql`${table.settled} = true`),
    check(
      'a2a_task_state_check',
      sql`${table.state} in ('submitted','working','input-required','completed','failed','canceled','rejected')`,
    ),
  ],
)

// Marks every thread the bot has ever accepted an event in, independent of
// whether that turn's processing went on to succeed. Unlike event_log (which
// rolls back its row when onAccepted fails so Slack's retry re-triggers
// dispatch) and a2a_task (only written once the LLM calls a delegation
// tool), this table is the one record that survives a crash between
// acceptance and dispatch, so a later mention-less reply in the thread can
// still be gated in as `thread_participation`.
//
// No retention/prune job, unlike event_log and a2a_task: this intentionally
// mirrors the LangGraph checkpointer's own unbounded retention, since
// thread_continuation (backed by the checkpointer) already keeps a thread
// eligible indefinitely, and thread_participation exists to cover the same
// threads for the case where the checkpoint never got written.
export const conversationThread = pgTable(
  'conversation_thread',
  {
    slackTeamId: text('slack_team_id').notNull(),
    slackChannelId: text('slack_channel_id').notNull(),
    threadRootTs: text('thread_root_ts').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Explicit name: the default (`<table>_<col1>_<col2>_<col3>_pk`) exceeds
    // PostgreSQL's 63-byte identifier limit for this column set and gets
    // silently truncated, leaving drizzle's tracked snapshot out of sync
    // with the actual constraint name in the catalog.
    primaryKey({
      name: 'conversation_thread_pk',
      columns: [table.slackTeamId, table.slackChannelId, table.threadRootTs],
    }),
  ],
)
