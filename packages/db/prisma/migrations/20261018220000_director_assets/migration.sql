SET lock_timeout = '5s';

-- The images made for a plan's assets: the default each asset gets right after indexing
-- (apps/ai/app/assets.py). A new, empty table that no running release reads, so the
-- rules below have nothing to scan or wait for; its foreign keys hold writes on the
-- tables they point at (auth.organization, auth.user, ai.director_plan) until the
-- migration commits: milliseconds, bounded by the lock timeout above.
-- squawk-ignore-file adding-foreign-key-constraint, constraint-missing-not-valid, require-concurrent-index-creation

-- CreateTable
CREATE TABLE "ai"."director_asset" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "user_id" UUID,
    "asset_id" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'default',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "object_key" TEXT,
    "model" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "director_asset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "director_asset_org_id_id_idx" ON "ai"."director_asset"("org_id", "id" DESC);

-- CreateIndex
CREATE INDEX "director_asset_plan_id_idx" ON "ai"."director_asset"("plan_id");

-- CreateIndex
CREATE INDEX "director_asset_user_id_created_at_idx" ON "ai"."director_asset"("user_id", "created_at");

-- One default per asset of a plan, however often its job runs.
-- CreateIndex
CREATE UNIQUE INDEX "director_asset_one_default" ON "ai"."director_asset"("plan_id", "asset_id") WHERE (origin = 'default');

-- AddForeignKey
ALTER TABLE "ai"."director_asset" ADD CONSTRAINT "director_asset_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai"."director_asset" ADD CONSTRAINT "director_asset_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "ai"."director_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai"."director_asset" ADD CONSTRAINT "director_asset_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The asset's id names its object in storage (director-assets/<planId>/<assetId>.<ext>),
-- so it is held to the plan's own pattern for one (app/schemas.py ASSET_ID_PATTERN).
ALTER TABLE ai.director_asset
  ADD CONSTRAINT director_asset_asset_id_check
    CHECK (asset_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(asset_id) <= 40),
  ADD CONSTRAINT director_asset_origin_check CHECK (origin IN ('default')),
  ADD CONSTRAINT director_asset_status_check
    CHECK (status IN ('pending', 'generating', 'ready', 'failed')),
  ADD CONSTRAINT director_asset_ready_has_key_check
    CHECK (status <> 'ready' OR object_key IS NOT NULL);

-- ---------------------------------------------------------------------------- tenancy
-- Every role sees only the organization in app.org_id.
ALTER TABLE ai.director_asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.director_asset FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.director_asset
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- ---------------------------------------------------------------------------- the limit
-- How many images a member has had made in the last day, in every workspace: the limit
-- (30 a day, apps/ai/app/assets.py) is the member's, but the AI service sees one
-- workspace at a time (row-level security). Owned by the table's owner, so it reads past
-- row-level security; it answers only a count.
CREATE OR REPLACE FUNCTION ai.images_today(user_id uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(*)::integer FROM ai.director_asset AS asset
   WHERE asset.user_id = images_today.user_id
     AND asset.created_at > now() - interval '1 day';
$$;
REVOKE EXECUTE ON FUNCTION ai.images_today(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.images_today(uuid) TO app_ai;

-- SECURITY DEFINER functions run as the table's owner (migrator), which forced row-level
-- security still applies to; this lets ai.images_today count every workspace's rows.
-- Read only: writes still need the workspace in app.org_id.
CREATE POLICY owner_functions ON ai.director_asset FOR SELECT TO migrator USING (true);

-- ---------------------------------------------------------------------------- privileges
-- apps/ai owns the asset images: it queues them with the plan and updates them as they
-- are drawn. They go with their plan, workspace or member, never deleted by the service.
-- apps/api reads them only through the AI service.
GRANT SELECT, INSERT, UPDATE ON ai.director_asset TO app_ai;
