import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { runner } from 'node-pg-migrate'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)
const migrationsDir = path.join(repoRoot, 'migrations')

// Requires a reachable Docker daemon. Opt in by setting RUN_DB_TESTS=1.
describe.skipIf(process.env['RUN_DB_TESTS'] !== '1')('migrations', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>
  let databaseUrl: string

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start()
    databaseUrl = container.getConnectionUri()

    await runner({
      databaseUrl,
      dir: migrationsDir,
      direction: 'up',
      migrationsTable: 'pgmigrations',
      verbose: false,
      log: () => {},
    })
  }, 120_000)

  afterAll(async () => {
    await container.stop()
  })

  it('creates the expected schema', async () => {
    const client = new Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name <> 'pgmigrations'
         ORDER BY table_name`,
      )

      const columns = await client.query<{
        table_name: string
        column_name: string
        data_type: string
        is_nullable: 'YES' | 'NO'
        column_default: string | null
      }>(
        `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name IN ('thread_session_map', 'event_log')
         ORDER BY table_name, ordinal_position`,
      )

      const indexes = await client.query<{
        table_name: string
        index_name: string
        index_def: string
      }>(
        `SELECT tablename AS table_name, indexname AS index_name, indexdef AS index_def
         FROM pg_indexes
         WHERE schemaname = 'public' AND tablename IN ('thread_session_map', 'event_log')
         ORDER BY tablename, indexname`,
      )

      const normalizeDefault = (value: string | null): string | null => {
        if (value === null) return null
        // Postgres echoes column defaults with explicit type casts (e.g. `'now()'::text`).
        return value.replace(/::[\w ]+(\[\])?/g, '')
      }

      const snapshot = {
        tables: tables.rows.map((r) => r.table_name),
        columns: columns.rows.map((r) => ({
          ...r,
          column_default: normalizeDefault(r.column_default),
        })),
        indexes: indexes.rows.map((r) => ({
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
            index_name: 'thread_session_map_pkey',
            index_def:
              'CREATE UNIQUE INDEX thread_session_map_pkey ON public.thread_session_map USING btree (slack_team_id, slack_channel_id, thread_root_ts)',
          },
          {
            table_name: 'thread_session_map',
            index_name: 'thread_session_map_session_idx',
            index_def:
              'CREATE UNIQUE INDEX thread_session_map_session_idx ON public.thread_session_map USING btree (opencode_session_id)',
          },
        ],
      })
    } finally {
      await client.end()
    }
  })
})
