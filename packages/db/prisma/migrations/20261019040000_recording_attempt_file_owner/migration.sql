SET lock_timeout = '5s';

-- An attempt's take goes with it, but the trigger that deletes it runs as the tables'
-- owner, past files.file's row-level security, and deleted whatever file the attempt's
-- file_id named. A bug that wrote another member's file there (or a file that's no take)
-- would have deleted it. It now deletes only a take video (director-take-video) of a
-- member of the attempt's own workspace. While the workspace itself is being deleted its
-- members may already be gone in the same statement, so a workspace that no longer
-- exists counts as the attempt's own: its member's files go with their account anyway.
CREATE OR REPLACE FUNCTION app.delete_recording_attempt_file() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.file_id IS NOT NULL THEN
    DELETE FROM files.file AS f
     WHERE f.id = OLD.file_id
       AND f.purpose = 'director-take-video'
       AND (
         EXISTS (SELECT 1 FROM auth.member AS m
                  WHERE m.organization_id = OLD.org_id AND m.user_id = f.user_id)
         OR NOT EXISTS (SELECT 1 FROM auth.organization AS o WHERE o.id = OLD.org_id)
       );
  END IF;
  RETURN OLD;
END $$;

-- CREATE OR REPLACE keeps the revoke; said again so this file stands alone. Only the
-- trigger calls it.
REVOKE EXECUTE ON FUNCTION app.delete_recording_attempt_file() FROM PUBLIC;

-- apps/api had every column of an attempt through the app schema's default privileges.
-- It writes only how a mark ends one (end_ms, status, note, and Prisma's updated_at);
-- the clip, the file and the take are apps/worker's. A table-wide revoke takes the
-- column privileges with it, so the columns are granted back after.
REVOKE UPDATE ON app.recording_attempt FROM app_api;
GRANT UPDATE (end_ms, status, note, updated_at) ON app.recording_attempt TO app_api;
