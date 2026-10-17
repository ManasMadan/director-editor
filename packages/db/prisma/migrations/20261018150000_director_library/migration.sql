SET lock_timeout = '5s';

-- The new columns have constant defaults, so adding them rewrites nothing. The ALTER takes
-- director_plan's ACCESS EXCLUSIVE lock and holds it until this migration commits: no
-- plan is written while the backfills below run and the one-index-per-member unique
-- index is built, so that index can't be raced by a write between the two. The table is
-- small (a workspace's library: six seeds and what its members indexed), so the build
-- takes milliseconds, bounded by the lock timeout above.
--
-- During the rollout the previous release still runs against this schema. It ignores the
-- new columns, but its request_plan doesn't know the one-short limit: asking for a second
-- short in a member's name hits the unique index and answers 500 (an unhandled integrity
-- error) until the new release replaces it. A short window, and the release is marked as
-- a breaking change.
ALTER TABLE "ai"."director_plan" ADD COLUMN     "audio_key" TEXT,
ADD COLUMN     "audio_status" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN     "stage" TEXT NOT NULL DEFAULT 'queued';

-- CreateTable
CREATE TABLE "ai"."director_cut" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "picks" JSONB NOT NULL,
    "file_id" UUID NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "publish_status" TEXT NOT NULL DEFAULT 'none',
    "youtube_video_id" TEXT,
    "visibility" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "director_cut_pkey" PRIMARY KEY ("id")
);

-- A new, empty table that no running release reads: nothing to scan or wait for. The
-- foreign keys hold writes on the tables they point at (auth.user, auth.organization,
-- files.file, ai.director_plan) until the migration commits: milliseconds.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "director_cut_org_id_id_idx" ON "ai"."director_cut"("org_id", "id" DESC);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "director_cut_plan_id_user_id_idx" ON "ai"."director_cut"("plan_id", "user_id");
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "director_cut_user_id_idx" ON "ai"."director_cut"("user_id");
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "director_cut_file_id_idx" ON "ai"."director_cut"("file_id");
-- squawk-ignore adding-foreign-key-constraint, constraint-missing-not-valid
ALTER TABLE "ai"."director_cut" ADD CONSTRAINT "director_cut_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- squawk-ignore adding-foreign-key-constraint, constraint-missing-not-valid
ALTER TABLE "ai"."director_cut" ADD CONSTRAINT "director_cut_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "ai"."director_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- squawk-ignore adding-foreign-key-constraint, constraint-missing-not-valid
ALTER TABLE "ai"."director_cut" ADD CONSTRAINT "director_cut_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- squawk-ignore adding-foreign-key-constraint, constraint-missing-not-valid
ALTER TABLE "ai"."director_cut" ADD CONSTRAINT "director_cut_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"."file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- squawk-ignore constraint-missing-not-valid
ALTER TABLE ai.director_cut ADD CONSTRAINT director_cut_publish_status_check CHECK (publish_status IN ('none', 'uploading', 'published', 'failed'));
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE ai.director_cut ADD CONSTRAINT director_cut_visibility_check CHECK (visibility IN ('private', 'unlisted', 'public'));
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE ai.director_cut ADD CONSTRAINT director_cut_youtube_video_id_check CHECK (youtube_video_id ~ '^[A-Za-z0-9_-]{11}$');
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE ai.director_cut ADD CONSTRAINT director_cut_duration_ms_check CHECK (duration_ms >= 0);
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE ai.director_cut ADD CONSTRAINT director_cut_picks_check CHECK (jsonb_typeof(picks) = 'array');

-- On a table with rows: NOT VALID, so adding them scans nothing. Every existing row holds
-- its column's default, which passes, and every write from now on is checked; a later
-- migration validates them.
ALTER TABLE ai.director_plan
  ADD CONSTRAINT director_plan_source_check CHECK (source IN ('seed', 'user')) NOT VALID,
  ADD CONSTRAINT director_plan_stage_check
    CHECK (stage IN ('queued', 'watching', 'writing', 'ready', 'failed')) NOT VALID,
  ADD CONSTRAINT director_plan_audio_status_check
    CHECK (audio_status IN ('ready', 'failed', 'none')) NOT VALID;

-- ---------------------------------------------------------------------------- backfill
-- Row-level security is forced on director_plan, for its owner (this migration's role)
-- too: with no workspace in app.org_id these updates would match no row at all. Lifted
-- for the two updates only, inside this migration's transaction, so no other session
-- ever sees the table without it.
ALTER TABLE ai.director_plan NO FORCE ROW LEVEL SECURITY;

-- A plan that's already finished reads as finished, not as queued.
UPDATE ai.director_plan SET stage = status WHERE status IN ('ready', 'failed');

-- Until now opening a short was enough to give it a plan in your name, so none of these
-- plans is a short someone chose to index. They stay in their workspaces' libraries in
-- nobody's name, so every member starts with their one index unused (the demo account
-- included). That covers a plan of a short that's also a seeded template: it counts for
-- no one now, and stays that workspace's plan of it ((org_id, video_id) is unique).
UPDATE ai.director_plan SET created_by = NULL WHERE source = 'user' AND created_by IS NOT NULL;

ALTER TABLE ai.director_plan FORCE ROW LEVEL SECURITY;

-- Not CONCURRENTLY: it has to see the table exactly as the update above left it, which
-- the ACCESS EXCLUSIVE lock this migration took at the top guarantees (see there).
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "director_plan_one_user_index" ON "ai"."director_plan"("created_by") WHERE (source = 'user' AND status <> 'failed');

-- ---------------------------------------------------------------------------- the limit
-- Whether a member has a short of their own that hasn't failed, in any workspace: the
-- limit (the index above) is across all of a member's workspaces, but the AI service sees
-- one workspace at a time (row-level security). Owned by the tables' owner, so it reads
-- past row-level security; it answers only yes or no.
CREATE OR REPLACE FUNCTION ai.index_used(user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM ai.director_plan AS plan
     WHERE plan.created_by = index_used.user_id
       AND plan.source = 'user'
       AND plan.status <> 'failed'
  );
$$;
REVOKE EXECUTE ON FUNCTION ai.index_used(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.index_used(uuid) TO app_ai;

-- SECURITY DEFINER functions run as the table's owner (migrator), which forced row-level
-- security still applies to. The owner could turn it off anyway, so this grants nothing
-- new; it lets ai.index_used read every workspace's plans. Read only: writes still need
-- the workspace in app.org_id.
CREATE POLICY owner_functions ON ai.director_plan FOR SELECT TO migrator USING (true);

-- ---------------------------------------------------------------------------- tenancy
-- Every role sees only the organization in app.org_id.
ALTER TABLE ai.director_cut ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.director_cut FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.director_cut
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- ---------------------------------------------------------------------------- privileges
-- apps/ai owns the cuts like the plans and takes: it records them and, while publishing,
-- updates where that got to. apps/api reads them (publishing to YouTube runs there, with
-- the member's Google sign-in); it changes them only through the AI service.
GRANT SELECT, INSERT, UPDATE ON ai.director_cut TO app_ai;
GRANT USAGE ON SCHEMA ai TO app_api;
GRANT SELECT ON ai.director_cut TO app_api;
