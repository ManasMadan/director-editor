SET lock_timeout = '5s';

-- Director's continuous recording (apps/api/src/modules/recording): a session per
-- "Start shooting", the parts and slices of its footage (the bytes are in storage under
-- recordings/<session>/<part>/<slice>), the attempts Director marks in it, each cut into
-- a take by the clipper, and the stretches it was paused. Owned by apps/api; apps/worker
-- sends each ended attempt's footage to the clipper and records the take it became.
--
-- Every statement these rules flag acts on a table created earlier in this migration: it is
-- empty and no running release reads it yet, so there is nothing to scan. The foreign keys
-- do hold writes on the tables they point at (auth.user, auth.organization,
-- ai.director_plan, ai.director_take, files.file) until the migration commits:
-- milliseconds, bounded by the lock timeout above.
-- squawk-ignore-file adding-foreign-key-constraint, constraint-missing-not-valid, require-concurrent-index-creation

-- CreateTable
CREATE TABLE "app"."recording_session" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "video_id" TEXT NOT NULL,
    "shot_count" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'recording',
    "demo" BOOLEAN NOT NULL DEFAULT false,
    "recorded_ms" INTEGER NOT NULL DEFAULT 0,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "recording_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."recording_part" (
    "session_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "camera" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "slice_count" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recording_part_pkey" PRIMARY KEY ("session_id","index")
);

-- CreateTable
CREATE TABLE "app"."recording_slice" (
    "session_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "part_index" INTEGER NOT NULL,
    "index" INTEGER NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "size" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_at" TIMESTAMPTZ(3),

    CONSTRAINT "recording_slice_pkey" PRIMARY KEY ("session_id","part_index","index")
);

-- CreateTable
CREATE TABLE "app"."recording_attempt" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "shot_index" INTEGER NOT NULL,
    "part_index" INTEGER NOT NULL,
    "line" TEXT,
    "note" TEXT,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'open',
    "clip_start_ms" INTEGER,
    "clip_end_ms" INTEGER,
    "file_id" UUID,
    "take_id" UUID,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recording_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."recording_pause" (
    "session_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "part_index" INTEGER NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER,
    "resumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recording_pause_pkey" PRIMARY KEY ("session_id","part_index","start_ms")
);

-- CreateIndex
CREATE INDEX "recording_session_org_id_user_id_created_at_idx" ON "app"."recording_session"("org_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "recording_session_user_id_idx" ON "app"."recording_session"("user_id");

-- CreateIndex
CREATE INDEX "recording_session_plan_id_idx" ON "app"."recording_session"("plan_id");

-- CreateIndex
CREATE INDEX "recording_session_expires_at_idx" ON "app"."recording_session"("expires_at");

-- CreateIndex
CREATE INDEX "recording_attempt_file_id_idx" ON "app"."recording_attempt"("file_id");

-- CreateIndex
CREATE INDEX "recording_attempt_take_id_idx" ON "app"."recording_attempt"("take_id");

-- CreateIndex
CREATE UNIQUE INDEX "recording_attempt_session_id_number_key" ON "app"."recording_attempt"("session_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "recording_attempt_one_open" ON "app"."recording_attempt"("session_id") WHERE (status = 'open');

-- CreateIndex
CREATE UNIQUE INDEX "recording_pause_one_open" ON "app"."recording_pause"("session_id") WHERE (resumed_at IS NULL);

-- AddForeignKey
ALTER TABLE "app"."recording_session" ADD CONSTRAINT "recording_session_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."recording_session" ADD CONSTRAINT "recording_session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."recording_session" ADD CONSTRAINT "recording_session_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "ai"."director_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."recording_part" ADD CONSTRAINT "recording_part_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "app"."recording_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."recording_slice" ADD CONSTRAINT "recording_slice_session_id_part_index_fkey" FOREIGN KEY ("session_id", "part_index") REFERENCES "app"."recording_part"("session_id", "index") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."recording_attempt" ADD CONSTRAINT "recording_attempt_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "app"."recording_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."recording_attempt" ADD CONSTRAINT "recording_attempt_session_id_part_index_fkey" FOREIGN KEY ("session_id", "part_index") REFERENCES "app"."recording_part"("session_id", "index") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."recording_attempt" ADD CONSTRAINT "recording_attempt_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"."file"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."recording_attempt" ADD CONSTRAINT "recording_attempt_take_id_fkey" FOREIGN KEY ("take_id") REFERENCES "ai"."director_take"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."recording_pause" ADD CONSTRAINT "recording_pause_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "app"."recording_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."recording_pause" ADD CONSTRAINT "recording_pause_session_id_part_index_fkey" FOREIGN KEY ("session_id", "part_index") REFERENCES "app"."recording_part"("session_id", "index") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE app.recording_session
  ADD CONSTRAINT recording_session_status_check CHECK (status IN ('recording', 'done')),
  ADD CONSTRAINT recording_session_video_id_check CHECK (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  ADD CONSTRAINT recording_session_shot_count_check CHECK (shot_count > 0),
  ADD CONSTRAINT recording_session_recorded_check CHECK (recorded_ms >= 0 AND bytes >= 0);
ALTER TABLE app.recording_part
  ADD CONSTRAINT recording_part_index_check CHECK (index >= 0),
  ADD CONSTRAINT recording_part_camera_check CHECK (camera IN ('front', 'back')),
  ADD CONSTRAINT recording_part_content_type_check CHECK (content_type IN ('video/webm', 'video/mp4')),
  ADD CONSTRAINT recording_part_slice_count_check CHECK (slice_count >= 0);
ALTER TABLE app.recording_slice
  ADD CONSTRAINT recording_slice_index_check CHECK (index >= 0),
  ADD CONSTRAINT recording_slice_status_check CHECK (status IN ('pending', 'uploaded')),
  ADD CONSTRAINT recording_slice_times_check CHECK (start_ms >= 0 AND duration_ms > 0),
  ADD CONSTRAINT recording_slice_size_check CHECK (size > 0);
ALTER TABLE app.recording_attempt
  ADD CONSTRAINT recording_attempt_status_check
    CHECK (status IN ('open', 'waiting', 'clipping', 'clipped', 'failed')),
  ADD CONSTRAINT recording_attempt_number_check CHECK (number > 0),
  ADD CONSTRAINT recording_attempt_shot_index_check CHECK (shot_index >= 0),
  ADD CONSTRAINT recording_attempt_marks_check CHECK (start_ms >= 0 AND end_ms >= start_ms),
  ADD CONSTRAINT recording_attempt_clip_check CHECK (clip_start_ms >= 0 AND clip_end_ms > clip_start_ms);
ALTER TABLE app.recording_pause
  ADD CONSTRAINT recording_pause_times_check CHECK (start_ms >= 0 AND end_ms >= start_ms);

-- ---------------------------------------------------------------------------- tenancy
-- Every role sees only the organization in app.org_id; the API also holds each query to
-- the member's own sessions.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app.recording_session', 'app.recording_part', 'app.recording_slice',
                           'app.recording_attempt', 'app.recording_pause'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s
         USING (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)
         WITH CHECK (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------- storage
-- However a slice's row goes (its session deleted or expired, its workspace or member
-- gone), its object is queued for deletion from storage; the worker's files cleanup
-- drains the queue.
CREATE OR REPLACE FUNCTION app.queue_recording_slice_deletion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO files.object_deletion (key)
  VALUES ('recordings/' || OLD.session_id || '/' || OLD.part_index || '/' || OLD.index)
  ON CONFLICT (key) DO NOTHING;
  RETURN OLD;
END $$;

CREATE TRIGGER queue_recording_slice_deletion AFTER DELETE ON app.recording_slice
  FOR EACH ROW EXECUTE FUNCTION app.queue_recording_slice_deletion();

-- An attempt's take goes with it: however its row goes ("delete this session", expiry,
-- the workspace or member gone), its file is deleted in the same transaction, and the
-- take with the file (ai.director_take cascades). The worker sets an attempt's file in a
-- transaction that fails once the attempt is gone, so a clip finishing while its session
-- is deleted can't leave a take behind either.
CREATE OR REPLACE FUNCTION app.delete_recording_attempt_file() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.file_id IS NOT NULL THEN
    DELETE FROM files.file WHERE id = OLD.file_id;
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER delete_recording_attempt_file AFTER DELETE ON app.recording_attempt
  FOR EACH ROW EXECUTE FUNCTION app.delete_recording_attempt_file();

-- ---------------------------------------------------------------------------- retention
-- Raw footage goes at its session's expires_at (7 days after the last video saved from
-- it, 14 at most; the API keeps it current), its attempts' takes with it only for the demo
-- (24 hours): anyone else's takes stay, with their videos, so their attempts let go of
-- them first. Batched, so no long lock on a busy table.
CREATE OR REPLACE FUNCTION app.purge_expired_recordings() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  total bigint := 0;
  batch bigint;
BEGIN
  UPDATE app.recording_attempt a SET file_id = NULL, take_id = NULL
    FROM app.recording_session s
   WHERE s.id = a.session_id AND NOT s.demo AND s.expires_at < now() AND a.file_id IS NOT NULL;
  LOOP
    DELETE FROM app.recording_session WHERE id IN (
      SELECT id FROM app.recording_session WHERE expires_at < now() LIMIT 500
    );
    GET DIAGNOSTICS batch = ROW_COUNT;
    total := total + batch;
    EXIT WHEN batch < 500;
  END LOOP;
  RETURN total;
END $$;

-- Sessions whose footage has stopped coming, after `idle` with nothing reaching them:
-- one nobody finished (the tab closed and never reopened), and one finished with a part
-- whose recorder never said how many slices it made, a slice that never arrived, or an
-- attempt still waiting for its footage (Done, then the tab closed before the queue
-- drained). Each such part keeps the slices uploaded from its first without a gap,
-- whatever its recorder said; an attempt still open runs to its part's end; the session
-- is done. Answers every attempt of those sessions waiting for its footage, which is now
-- all there is, for the worker to send to the clipper (one with no footage left fails).
CREATE OR REPLACE FUNCTION app.finish_idle_recordings(idle interval)
RETURNS TABLE (org_id uuid, attempt_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  sessions uuid[];
BEGIN
  SELECT coalesce(array_agg(s.id), '{}') INTO sessions
    FROM app.recording_session s
   WHERE s.updated_at < now() - idle
     AND (s.status = 'recording'
          OR EXISTS (SELECT 1 FROM app.recording_attempt a
                      WHERE a.session_id = s.id AND a.status IN ('open', 'waiting')));
  UPDATE app.recording_part p
     SET slice_count = run.stored
    FROM (
      SELECT pp.session_id, pp.index, (
        SELECT count(*)::int FROM (
          SELECT sl.index, row_number() OVER (ORDER BY sl.index) - 1 AS expected
            FROM app.recording_slice sl
           WHERE sl.session_id = pp.session_id AND sl.part_index = pp.index
             AND sl.status = 'uploaded'
        ) numbered
        WHERE numbered.index = numbered.expected
      ) AS stored
      FROM app.recording_part pp
     WHERE pp.session_id = ANY (sessions)
    ) run
   WHERE p.session_id = run.session_id AND p.index = run.index
     AND (p.slice_count IS NULL OR p.slice_count > run.stored);
  UPDATE app.recording_attempt a
     SET status = 'waiting', updated_at = now()
   WHERE a.session_id = ANY (sessions) AND a.status = 'open';
  UPDATE app.recording_pause pa
     SET resumed_at = now()
   WHERE pa.session_id = ANY (sessions) AND pa.resumed_at IS NULL;
  UPDATE app.recording_session s
     SET status = 'done', finished_at = coalesce(s.finished_at, now()), updated_at = now()
   WHERE s.id = ANY (sessions);
  RETURN QUERY
    SELECT a.org_id, a.id FROM app.recording_attempt a
     WHERE a.session_id = ANY (sessions) AND a.status = 'waiting';
END $$;

-- Under forced row-level security even these functions' owner sees nothing without a
-- policy of its own (packages/db/test/security.test.ts).
CREATE POLICY owner_functions ON app.recording_session TO migrator USING (true) WITH CHECK (true);
CREATE POLICY owner_functions ON app.recording_part TO migrator USING (true) WITH CHECK (true);
CREATE POLICY owner_functions ON app.recording_slice TO migrator USING (true) WITH CHECK (true);
CREATE POLICY owner_functions ON app.recording_attempt TO migrator USING (true) WITH CHECK (true);
CREATE POLICY owner_functions ON app.recording_pause TO migrator USING (true) WITH CHECK (true);
-- A DELETE with a WHERE reads the rows it deletes, so the owner needs both.
CREATE POLICY recording_functions_read ON files.file FOR SELECT TO migrator USING (true);
CREATE POLICY recording_functions ON files.file FOR DELETE TO migrator USING (true);

REVOKE EXECUTE ON FUNCTION
  app.queue_recording_slice_deletion(),
  app.delete_recording_attempt_file(),
  app.purge_expired_recordings(),
  app.finish_idle_recordings(interval)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.purge_expired_recordings(),
  app.finish_idle_recordings(interval)
TO app_worker;

-- ---------------------------------------------------------------------------- privileges
-- apps/api has the app schema's default privileges. apps/worker reads a session's
-- footage and attempts to send one to the clipper, records how it went on the attempt,
-- and makes the take's file: a clip it cut itself, in a row of its own (processing, then
-- ready through the processing columns it already updates). Row-level security holds it
-- to the workspace in app.org_id on the recording tables.
GRANT SELECT ON app.recording_session, app.recording_part, app.recording_slice,
  app.recording_attempt, app.recording_pause TO app_worker;
GRANT UPDATE (status, clip_start_ms, clip_end_ms, file_id, take_id, error, updated_at)
  ON app.recording_attempt TO app_worker;
GRANT INSERT (id, user_id, purpose, status, filename, declared_type, declared_size, created_at,
  updated_at) ON files.file TO app_worker;
