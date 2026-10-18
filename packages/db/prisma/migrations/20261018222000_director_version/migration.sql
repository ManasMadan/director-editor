SET lock_timeout = '5s';

-- A member's version of a Director template: what Director remembers from the
-- conversation ("inside", "one angle"), the shots it changed for them and the ones they
-- skipped or left as gaps, as JSON the API parses with @repo/contracts yourVersionSchema.
-- One row per member and template, written by apps/api (which owns the app schema and
-- has its default privileges). A new table: the previous release never reads it.

-- CreateTable
CREATE TABLE "app"."director_version" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "video_id" TEXT NOT NULL,
    "version" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "director_version_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "director_version_user_id_idx" ON "app"."director_version"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "director_version_org_id_user_id_video_id_key" ON "app"."director_version"("org_id", "user_id", "video_id");

-- AddForeignKey
ALTER TABLE "app"."director_version" ADD CONSTRAINT "director_version_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."director_version" ADD CONSTRAINT "director_version_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE app.director_version
  ADD CONSTRAINT director_version_video_id_check CHECK (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  ADD CONSTRAINT director_version_version_check CHECK (jsonb_typeof(version) = 'object');

-- Every role sees only the organization in app.org_id.
ALTER TABLE app.director_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.director_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.director_version
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
