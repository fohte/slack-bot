CREATE INDEX "a2a_task_settled_idx" ON "a2a_task" USING btree ("updated_at") WHERE "a2a_task"."settled" = true;
