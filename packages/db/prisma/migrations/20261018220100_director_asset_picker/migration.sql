SET lock_timeout = '5s';

-- The asset picker: a member's own images for a plan's asset slots (drawn from their
-- prompt, uploaded, or copied from stock) beside each slot's default, and which one
-- they use in each slot. Expand only: new nullable columns, a wider check, a new table.
-- The new table is empty and no running release reads it; its foreign keys hold writes
-- on the tables they point at until the migration commits: milliseconds, bounded by the
-- lock timeout above.
-- squawk-ignore-file adding-foreign-key-constraint, require-concurrent-index-creation

-- AlterTable
ALTER TABLE "ai"."director_asset" ADD COLUMN     "base_id" UUID,
ADD COLUMN     "credit" JSONB,
ADD COLUMN     "file_id" UUID,
ADD COLUMN     "prompt" TEXT,
ADD COLUMN     "reference_key" TEXT;

-- A member's own images sit beside the defaults. Added NOT VALID and validated apart,
-- so the scan of the existing rows holds no lock that blocks writes.
ALTER TABLE ai.director_asset DROP CONSTRAINT director_asset_origin_check;
ALTER TABLE ai.director_asset
  ADD CONSTRAINT director_asset_origin_check
    CHECK (origin IN ('default', 'created', 'upload', 'stock')) NOT VALID;
ALTER TABLE ai.director_asset VALIDATE CONSTRAINT director_asset_origin_check;

-- CreateTable
CREATE TABLE "ai"."director_asset_choice" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "asset_id" TEXT NOT NULL,
    "candidate_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "director_asset_choice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "director_asset_choice_plan_id_user_id_asset_id_id_idx" ON "ai"."director_asset_choice"("plan_id", "user_id", "asset_id", "id" DESC);

-- CreateIndex
CREATE INDEX "director_asset_choice_org_id_id_idx" ON "ai"."director_asset_choice"("org_id", "id" DESC);

-- CreateIndex
CREATE INDEX "director_asset_choice_user_id_idx" ON "ai"."director_asset_choice"("user_id");

-- CreateIndex
CREATE INDEX "director_asset_choice_candidate_id_idx" ON "ai"."director_asset_choice"("candidate_id");

-- AddForeignKey
ALTER TABLE "ai"."director_asset_choice" ADD CONSTRAINT "director_asset_choice_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai"."director_asset_choice" ADD CONSTRAINT "director_asset_choice_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "ai"."director_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai"."director_asset_choice" ADD CONSTRAINT "director_asset_choice_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai"."director_asset_choice" ADD CONSTRAINT "director_asset_choice_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "ai"."director_asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The slot's id is the plan's asset id, held to the plan's own pattern for one.
ALTER TABLE ai.director_asset_choice
  ADD CONSTRAINT director_asset_choice_asset_id_check
    CHECK (asset_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(asset_id) <= 40);

-- ---------------------------------------------------------------------------- tenancy
-- Every role sees only the organization in app.org_id.
ALTER TABLE ai.director_asset_choice ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.director_asset_choice FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.director_asset_choice
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- ---------------------------------------------------------------------------- the limit
-- Only drawn images count against a member's 30 a day: an upload or a stock picture
-- costs no model call.
CREATE OR REPLACE FUNCTION ai.images_today(user_id uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(*)::integer FROM ai.director_asset AS asset
   WHERE asset.user_id = images_today.user_id
     AND asset.origin IN ('default', 'created')
     AND asset.created_at > now() - interval '1 day';
$$;

-- ---------------------------------------------------------------------------- privileges
-- apps/ai records the choices. A slot's history is every choice made in it, so the
-- service never changes or deletes one; they go with their plan, workspace or member.
GRANT SELECT, INSERT ON ai.director_asset_choice TO app_ai;
