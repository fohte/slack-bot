import type { MigrationBuilder } from 'node-pg-migrate'

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE thread_session_map (
      slack_team_id        TEXT NOT NULL,
      slack_channel_id     TEXT NOT NULL,
      thread_root_ts       TEXT NOT NULL,
      opencode_session_id  TEXT NOT NULL,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (slack_team_id, slack_channel_id, thread_root_ts)
    );

    CREATE UNIQUE INDEX thread_session_map_session_idx
      ON thread_session_map (opencode_session_id);

    CREATE TABLE event_log (
      slack_event_id       TEXT PRIMARY KEY,
      received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      outcome              TEXT NOT NULL,
      slack_team_id        TEXT,
      slack_channel_id     TEXT,
      thread_root_ts       TEXT,
      task_name            TEXT
    );

    CREATE INDEX event_log_received_idx ON event_log (received_at);
  `)
}

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP TABLE IF EXISTS event_log;
    DROP TABLE IF EXISTS thread_session_map;
  `)
}
