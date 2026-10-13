-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "files";

-- CreateTable
CREATE TABLE "files"."file" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "filename" TEXT NOT NULL,
    "declared_type" TEXT NOT NULL,
    "declared_size" INTEGER NOT NULL,
    "content_type" TEXT,
    "size" INTEGER,
    "sha256" TEXT,
    "reject_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "ready_at" TIMESTAMPTZ(3),

    CONSTRAINT "file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files"."object_deletion" (
    "key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "object_deletion_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "file_user_id_created_at_idx" ON "files"."file"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "file_status_created_at_idx" ON "files"."file"("status", "created_at");

-- AddForeignKey
ALTER TABLE "files"."file" ADD CONSTRAINT "file_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "files"."file"
  ADD CONSTRAINT file_status_check CHECK (status IN ('pending', 'processing', 'ready', 'rejected')),
  ADD CONSTRAINT file_declared_size_check CHECK (declared_size > 0);

-- ---------------------------------------------------------------------------- privacy
-- An uploader sees and manages only their own files (app.user_id, set by withUser).
-- Ready avatars are shown next to names everywhere, so anyone signed in may read those.
-- The worker checks every upload, whoever made it.
ALTER TABLE files.file ENABLE ROW LEVEL SECURITY;
ALTER TABLE files.file FORCE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON files.file
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY ready_avatars ON files.file FOR SELECT
  USING (purpose = 'avatar' AND status = 'ready');
CREATE POLICY worker_processing ON files.file TO app_worker USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------- cleanup
-- However a row goes (removed, replaced, its user deleted), its objects are queued for
-- deletion from storage; the worker's maintenance drains the queue.
CREATE OR REPLACE FUNCTION files.queue_object_deletion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO files.object_deletion (key)
  VALUES ('quarantine/' || OLD.id), ('files/' || OLD.id)
  ON CONFLICT (key) DO NOTHING;
  RETURN OLD;
END $$;

CREATE TRIGGER queue_object_deletion AFTER DELETE ON files.file
  FOR EACH ROW EXECUTE FUNCTION files.queue_object_deletion();

-- ---------------------------------------------------------------------------- privileges

GRANT USAGE ON SCHEMA files TO app_api, app_worker;
-- apps/api: requests uploads and removes files.
GRANT SELECT, INSERT, DELETE ON files.file TO app_api;
-- apps/worker: records what checking an upload found, and cleans up.
GRANT SELECT, DELETE ON files.file TO app_worker;
GRANT UPDATE (status, content_type, size, sha256, reject_reason, ready_at, updated_at)
  ON files.file TO app_worker;
GRANT SELECT, DELETE ON files.object_deletion TO app_worker;
