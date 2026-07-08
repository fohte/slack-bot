ALTER TABLE "event_log" ADD COLUMN "message_ts" text;--> statement-breakpoint
CREATE INDEX "event_log_message_lookup_idx" ON "event_log" USING btree ("slack_channel_id","message_ts","slack_team_id");
