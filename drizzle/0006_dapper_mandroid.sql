CREATE TABLE "conversation_thread" (
	"slack_team_id" text NOT NULL,
	"slack_channel_id" text NOT NULL,
	"thread_root_ts" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_thread_pk" PRIMARY KEY("slack_team_id","slack_channel_id","thread_root_ts")
);
