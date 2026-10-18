SET lock_timeout = '5s';

-- The post-session pass (apps/ai app/session_pass.py) goes through a session once it's
-- done. apps/api queued it only when its own Done call flipped the session, and after
-- the commit: a queue that failed then was never tried again, and a session the idle
-- sweeper finished never got a pass at all. When it was queued is now kept on the
-- session; apps/api queues it whenever a Done call finds it unqueued, and the worker's
-- recording retention queues any done session still without one (the session's id is
-- the job's, so it runs once).
--
-- Expand only: a nullable column. The release before this neither reads nor writes it;
-- a session it finishes during the rollout is queued by it and, an hour later, by the
-- worker too, which the job id keeps to one pass while the first is kept (a day).
ALTER TABLE app.recording_session ADD COLUMN pass_queued_at timestamptz(3);

-- Sessions done before this: their pass was queued then (or, closed by the sweeper, never
-- will be; their footage is days old). Not queued again now. A handful of rows.
UPDATE app.recording_session
   SET pass_queued_at = coalesce(finished_at, updated_at)
 WHERE status = 'done';

-- The worker's retention, across workspaces, as the tables' owner (the recording
-- tables' owner_functions policy lets it): done sessions with no pass queued, oldest
-- first, a batch at a time; then the ones it queued, stamped. One apps/api is queueing
-- at the same moment is the same job (the session's id), so it's queued once either way.
CREATE OR REPLACE FUNCTION app.session_passes_due(most int)
RETURNS TABLE (org_id uuid, session_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.org_id, s.id
    FROM app.recording_session AS s
   WHERE s.status = 'done' AND s.pass_queued_at IS NULL
   ORDER BY s.finished_at NULLS FIRST, s.id
   LIMIT most;
$$;

CREATE OR REPLACE FUNCTION app.session_passes_queued(sessions uuid[]) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  stamped bigint;
BEGIN
  UPDATE app.recording_session
     SET pass_queued_at = now()
   WHERE id = ANY (sessions) AND pass_queued_at IS NULL;
  GET DIAGNOSTICS stamped = ROW_COUNT;
  RETURN stamped;
END $$;

REVOKE EXECUTE ON FUNCTION
  app.session_passes_due(int),
  app.session_passes_queued(uuid[])
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.session_passes_due(int),
  app.session_passes_queued(uuid[])
TO app_worker;
