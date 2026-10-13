SET lock_timeout = '5s';

-- Every statement these rules flag acts on a table created earlier in this migration: it is
-- empty and no running release reads it yet, so there is nothing to scan. The foreign keys
-- do hold writes on the tables they point at (auth.user, auth.organization, files.file)
-- until the migration commits: milliseconds, bounded by the lock timeout above.
-- squawk-ignore-file adding-foreign-key-constraint, constraint-missing-not-valid, require-concurrent-index-creation

-- CreateTable
CREATE TABLE "ai"."director_plan" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "created_by" UUID,
    "video_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "plan" JSONB,
    "model" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "director_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai"."director_take" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "shot_index" INTEGER NOT NULL,
    "file_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "best_start_ms" INTEGER,
    "best_end_ms" INTEGER,
    "score" INTEGER,
    "feedback" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "director_take_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."short_reaction" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "video_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "short_reaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "director_plan_org_id_id_idx" ON "ai"."director_plan"("org_id", "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "director_plan_org_id_video_id_key" ON "ai"."director_plan"("org_id", "video_id");

-- CreateIndex
CREATE INDEX "director_take_org_id_id_idx" ON "ai"."director_take"("org_id", "id" DESC);

-- CreateIndex
CREATE INDEX "director_take_plan_id_user_id_shot_index_idx" ON "ai"."director_take"("plan_id", "user_id", "shot_index");

-- CreateIndex
CREATE INDEX "director_take_user_id_idx" ON "ai"."director_take"("user_id");

-- CreateIndex
CREATE INDEX "director_take_file_id_idx" ON "ai"."director_take"("file_id");

-- CreateIndex
CREATE INDEX "short_reaction_org_id_id_idx" ON "app"."short_reaction"("org_id", "id" DESC);

-- CreateIndex
CREATE INDEX "short_reaction_user_id_idx" ON "app"."short_reaction"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "short_reaction_org_id_user_id_video_id_kind_key" ON "app"."short_reaction"("org_id", "user_id", "video_id", "kind");

-- AddForeignKey
ALTER TABLE "ai"."director_plan" ADD CONSTRAINT "director_plan_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai"."director_plan" ADD CONSTRAINT "director_plan_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai"."director_take" ADD CONSTRAINT "director_take_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai"."director_take" ADD CONSTRAINT "director_take_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "ai"."director_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai"."director_take" ADD CONSTRAINT "director_take_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai"."director_take" ADD CONSTRAINT "director_take_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"."file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."short_reaction" ADD CONSTRAINT "short_reaction_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."short_reaction" ADD CONSTRAINT "short_reaction_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE ai.director_plan
  ADD CONSTRAINT director_plan_status_check CHECK (status IN ('pending', 'analyzing', 'ready', 'failed')),
  ADD CONSTRAINT director_plan_video_id_check CHECK (video_id ~ '^[A-Za-z0-9_-]{11}$');
ALTER TABLE ai.director_take
  ADD CONSTRAINT director_take_status_check CHECK (status IN ('pending', 'reviewing', 'ready', 'failed')),
  ADD CONSTRAINT director_take_kind_check CHECK (kind IN ('video', 'photo')),
  ADD CONSTRAINT director_take_shot_index_check CHECK (shot_index >= 0),
  ADD CONSTRAINT director_take_score_check CHECK (score BETWEEN 0 AND 100),
  ADD CONSTRAINT director_take_best_range_check CHECK (best_end_ms > best_start_ms AND best_start_ms >= 0);
ALTER TABLE app.short_reaction
  ADD CONSTRAINT short_reaction_kind_check CHECK (kind IN ('like', 'save')),
  ADD CONSTRAINT short_reaction_video_id_check CHECK (video_id ~ '^[A-Za-z0-9_-]{11}$');

-- ---------------------------------------------------------------------------- tenancy
-- Every role sees only the organization in app.org_id.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai.director_plan', 'ai.director_take', 'app.short_reaction'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s
         USING (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)
         WITH CHECK (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------- privileges
-- apps/ai owns the director tables; apps/api reaches them only through that service.
-- Plans are rewritten when an analysis is retried and takes when they're reviewed;
-- neither is deleted by the service (they go with their workspace, user or file).
GRANT SELECT, INSERT, UPDATE ON ai.director_plan, ai.director_take TO app_ai;
