import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export const threadSessionMap = pgTable(
  'thread_session_map',
  {
    slackTeamId: text('slack_team_id').notNull(),
    slackChannelId: text('slack_channel_id').notNull(),
    threadRootTs: text('thread_root_ts').notNull(),
    opencodeSessionId: text('opencode_session_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'thread_session_map_pk',
      columns: [table.slackTeamId, table.slackChannelId, table.threadRootTs],
    }),
    uniqueIndex('thread_session_map_session_idx').on(table.opencodeSessionId),
  ],
)

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
