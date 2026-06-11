import {
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
  },
  (table) => [index('event_log_received_idx').on(table.receivedAt)],
)
