import { PostgreSqlContainer } from '@testcontainers/postgresql'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runMigrations } from '@/db/migrator'

describe.skipIf(process.env['RUN_DB_TESTS'] !== '1')('migrations', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>> | undefined
  let databaseUrl: string

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start()
    databaseUrl = container.getConnectionUri()
    await runMigrations(databaseUrl)
  }, 120_000)

  afterAll(async () => {
    await container?.stop()
  })

  it('creates the expected schema', async () => {
    const client = postgres(databaseUrl, { max: 1 })
    try {
      const tables = await client<{ table_name: string }[]>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name NOT LIKE '__drizzle%'
        ORDER BY table_name
      `

      const columns = await client<
        {
          table_name: string
          column_name: string
          data_type: string
          is_nullable: 'YES' | 'NO'
          column_default: string | null
        }[]
      >`
        SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('thread_session_map', 'event_log')
        ORDER BY table_name, ordinal_position
      `

      const indexes = await client<
        { table_name: string; index_name: string; index_def: string }[]
      >`
        SELECT tablename AS table_name, indexname AS index_name, indexdef AS index_def
        FROM pg_indexes
        WHERE schemaname = 'public' AND tablename IN ('thread_session_map', 'event_log')
        ORDER BY tablename, indexname
      `

      const snapshot = {
        tables: tables.map((r) => r.table_name),
        columns: columns.map((r) => ({ ...r })),
        indexes: indexes.map((r) => ({
          table_name: r.table_name,
          index_name: r.index_name,
          index_def: r.index_def.replace(/\s+/g, ' '),
        })),
      }

      expect(snapshot).toEqual({
        tables: ['event_log', 'thread_session_map'],
        columns: [
          {
            table_name: 'event_log',
            column_name: 'slack_event_id',
            data_type: 'text',
            is_nullable: 'NO',
            column_default: null,
          },
          {
            table_name: 'event_log',
            column_name: 'received_at',
            data_type: 'timestamp with time zone',
            is_nullable: 'NO',
            column_default: 'now()',
          },
          {
            table_name: 'event_log',
            column_name: 'outcome',
            data_type: 'text',
            is_nullable: 'NO',
            column_default: null,
          },
          {
            table_name: 'event_log',
            column_name: 'slack_team_id',
            data_type: 'text',
            is_nullable: 'YES',
            column_default: null,
          },
          {
            table_name: 'event_log',
            column_name: 'slack_channel_id',
            data_type: 'text',
            is_nullable: 'YES',
            column_default: null,
          },
          {
            table_name: 'event_log',
            column_name: 'thread_root_ts',
            data_type: 'text',
            is_nullable: 'YES',
            column_default: null,
          },
          {
            table_name: 'event_log',
            column_name: 'task_name',
            data_type: 'text',
            is_nullable: 'YES',
            column_default: null,
          },
          {
            table_name: 'thread_session_map',
            column_name: 'slack_team_id',
            data_type: 'text',
            is_nullable: 'NO',
            column_default: null,
          },
          {
            table_name: 'thread_session_map',
            column_name: 'slack_channel_id',
            data_type: 'text',
            is_nullable: 'NO',
            column_default: null,
          },
          {
            table_name: 'thread_session_map',
            column_name: 'thread_root_ts',
            data_type: 'text',
            is_nullable: 'NO',
            column_default: null,
          },
          {
            table_name: 'thread_session_map',
            column_name: 'opencode_session_id',
            data_type: 'text',
            is_nullable: 'NO',
            column_default: null,
          },
          {
            table_name: 'thread_session_map',
            column_name: 'created_at',
            data_type: 'timestamp with time zone',
            is_nullable: 'NO',
            column_default: 'now()',
          },
          {
            table_name: 'thread_session_map',
            column_name: 'updated_at',
            data_type: 'timestamp with time zone',
            is_nullable: 'NO',
            column_default: 'now()',
          },
        ],
        indexes: [
          {
            table_name: 'event_log',
            index_name: 'event_log_pkey',
            index_def:
              'CREATE UNIQUE INDEX event_log_pkey ON public.event_log USING btree (slack_event_id)',
          },
          {
            table_name: 'event_log',
            index_name: 'event_log_received_idx',
            index_def:
              'CREATE INDEX event_log_received_idx ON public.event_log USING btree (received_at)',
          },
          {
            table_name: 'thread_session_map',
            index_name: 'thread_session_map_session_idx',
            index_def:
              'CREATE UNIQUE INDEX thread_session_map_session_idx ON public.thread_session_map USING btree (opencode_session_id)',
          },
          {
            table_name: 'thread_session_map',
            index_name:
              'thread_session_map_slack_team_id_slack_channel_id_thread_root_t',
            index_def:
              'CREATE UNIQUE INDEX thread_session_map_slack_team_id_slack_channel_id_thread_root_t ON public.thread_session_map USING btree (slack_team_id, slack_channel_id, thread_root_ts)',
          },
        ],
      })
    } finally {
      await client.end()
    }
  })
})
