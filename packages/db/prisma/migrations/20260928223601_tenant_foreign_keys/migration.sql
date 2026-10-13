-- Fail fast instead of queueing behind long transactions: a migration that cannot take
-- its locks within 5s aborts, rather than blocking every query on the table meanwhile.
SET lock_timeout = '5s';

-- Rows outlive the member who created them (SET NULL below).
ALTER TABLE "app"."todo" ALTER COLUMN "created_by_id" DROP NOT NULL;

CREATE INDEX "todo_created_by_id_idx" ON "app"."todo"("created_by_id");

-- Foreign keys are added NOT VALID (instant, no table scan under lock) and validated
-- separately (a scan that doesn't block writes): the safe pattern for tables with data.
-- Deleting an organization removes its data; deleting a user keeps the org's rows.
ALTER TABLE "app"."todo" ADD CONSTRAINT "todo_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "app"."todo" VALIDATE CONSTRAINT "todo_org_id_fkey";

ALTER TABLE "app"."todo" ADD CONSTRAINT "todo_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "auth"."user"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "app"."todo" VALIDATE CONSTRAINT "todo_created_by_id_fkey";
