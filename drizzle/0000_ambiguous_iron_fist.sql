CREATE TABLE "event_log" (
	"slack_event_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	"slack_team_id" text,
	"slack_channel_id" text,
	"thread_root_ts" text,
	"task_name" text
);
--> statement-breakpoint
CREATE TABLE "thread_session_map" (
	"slack_team_id" text NOT NULL,
	"slack_channel_id" text NOT NULL,
	"thread_root_ts" text NOT NULL,
	"opencode_session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_session_map_slack_team_id_slack_channel_id_thread_root_ts_pk" PRIMARY KEY("slack_team_id","slack_channel_id","thread_root_ts")
);
--> statement-breakpoint
CREATE INDEX "event_log_received_idx" ON "event_log" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_session_map_session_idx" ON "thread_session_map" USING btree ("opencode_session_id");
