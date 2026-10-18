SET lock_timeout = '5s';

-- The shared demo account (everyone who signs in to it is the same member) keeps nothing
-- of a visitor's past a day, so the next one never sees it. apps/api now refuses its new
-- per-member writes (DEMO_ACCOUNT_LOCKED); this clears what it kept before, and anything
-- still made some other way. Besides its takes' and videos' files, the daily purge now
-- deletes, once older than `older_than`:
--   - its brief photos and asset uploads (files.file, director-brief-photo and
--     director-asset-image; their objects are queued for removal by the files trigger);
--   - the images it drew, uploaded or picked from stock for a template's assets
--     (ai.director_asset of origin created, upload or stock; a default image is the
--     workspace's and stays);
--   - the templates it described (ai.director_plan of source created, with everything
--     that cascades from them: their storyboards, takes, cuts and sessions);
--   - its versions of templates, what Director remembered of it (app.director_version).
-- Its library otherwise stays: the seeds and the one Short it indexed. Returns how many
-- rows went, all of these together.
CREATE OR REPLACE FUNCTION files.purge_demo_footage(older_than interval) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  shared uuid[];
  deleted bigint;
  total bigint := 0;
BEGIN
  SELECT coalesce(array_agg(u.id), '{}') INTO shared
    FROM auth."user" AS u
   WHERE u.demo AND u.guest_until IS NULL;

  DELETE FROM files.file AS f
   WHERE f.user_id = ANY (shared)
     AND f.purpose IN ('director-take-video', 'director-take-photo', 'director-cut-video',
                       'director-brief-photo', 'director-asset-image')
     AND f.created_at < now() - older_than;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  total := total + deleted;

  DELETE FROM ai.director_asset AS a
   WHERE a.user_id = ANY (shared)
     AND a.origin IN ('created', 'upload', 'stock')
     AND a.created_at < now() - older_than;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  total := total + deleted;

  DELETE FROM ai.director_plan AS p
   WHERE p.created_by = ANY (shared)
     AND p.source = 'created'
     AND p.created_at < now() - older_than;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  total := total + deleted;

  DELETE FROM app.director_version AS v
   WHERE v.user_id = ANY (shared)
     AND v.updated_at < now() - older_than;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN total + deleted;
END $$;

-- CREATE OR REPLACE keeps the function's privileges; said again so this file stands alone.
REVOKE EXECUTE ON FUNCTION files.purge_demo_footage(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION files.purge_demo_footage(interval) TO app_worker;

-- The function runs as the tables' owner, which forced row-level security still applies
-- to. It already reads ai.director_plan and ai.director_asset (owner_functions, FOR
-- SELECT) and files.file; these let it delete only the shared demo account's rows, and
-- read and delete only its versions.
CREATE POLICY shared_demo_purge ON ai.director_asset FOR DELETE TO migrator
  USING (EXISTS (
    SELECT 1 FROM auth."user" AS u
     WHERE u.id = director_asset.user_id AND u.demo AND u.guest_until IS NULL
  ));
CREATE POLICY shared_demo_purge ON ai.director_plan FOR DELETE TO migrator
  USING (EXISTS (
    SELECT 1 FROM auth."user" AS u
     WHERE u.id = director_plan.created_by AND u.demo AND u.guest_until IS NULL
  ));
CREATE POLICY shared_demo_purge_read ON app.director_version FOR SELECT TO migrator
  USING (EXISTS (
    SELECT 1 FROM auth."user" AS u
     WHERE u.id = director_version.user_id AND u.demo AND u.guest_until IS NULL
  ));
CREATE POLICY shared_demo_purge ON app.director_version FOR DELETE TO migrator
  USING (EXISTS (
    SELECT 1 FROM auth."user" AS u
     WHERE u.id = director_version.user_id AND u.demo AND u.guest_until IS NULL
  ));
