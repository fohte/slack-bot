DROP INDEX "a2a_task_unsettled_idx";--> statement-breakpoint
CREATE INDEX "a2a_task_unsettled_idx" ON "a2a_task" USING btree ("updated_at") WHERE "a2a_task"."settled" = false;--> statement-breakpoint
ALTER TABLE "a2a_task" ADD CONSTRAINT "a2a_task_state_check" CHECK ("a2a_task"."state" in ('submitted','working','input-required','completed','failed','canceled','rejected'));
