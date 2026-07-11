CREATE TABLE "a2a_task" (
	"task_id" text PRIMARY KEY NOT NULL,
	"context_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"slack_team_id" text NOT NULL,
	"slack_channel_id" text NOT NULL,
	"thread_root_ts" text NOT NULL,
	"slack_event_id" text NOT NULL,
	"state" text NOT NULL,
	"settled" boolean DEFAULT false NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "a2a_task_thread_idx" ON "a2a_task" USING btree ("slack_team_id","slack_channel_id","thread_root_ts");--> statement-breakpoint
CREATE INDEX "a2a_task_unsettled_idx" ON "a2a_task" USING btree ("settled","updated_at");
