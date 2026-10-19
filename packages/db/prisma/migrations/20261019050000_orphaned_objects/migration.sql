SET lock_timeout = '5s';

-- Objects in storage outlive no row.
--
-- A Director asset's images: however an ai.director_asset row goes (its plan, workspace or member deleted, a demo guest's day over, the shared demo
-- account's purge), the objects it named under director-assets/ (a default image, a
-- drawn, stock or storyboard one, a Veo clip, an edit's base) are queued for deletion,
-- like a recording's slices; the worker's files cleanup drains the queue. Every such key
-- carries its own plan row's id, so no other row names it. An upload's object
-- (files/<id>) isn't touched here: it goes with its files.file row, by that table's
-- trigger.
CREATE OR REPLACE FUNCTION ai.queue_director_asset_deletion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO files.object_deletion (key)
  SELECT k FROM unnest(ARRAY[OLD.object_key, OLD.reference_key]) AS k
   WHERE k LIKE 'director-assets/%'
  ON CONFLICT (key) DO NOTHING;
  RETURN OLD;
END $$;

-- Only the trigger calls it.
REVOKE EXECUTE ON FUNCTION ai.queue_director_asset_deletion() FROM PUBLIC;

CREATE TRIGGER queue_director_asset_deletion AFTER DELETE ON ai.director_asset
  FOR EACH ROW EXECUTE FUNCTION ai.queue_director_asset_deletion();

-- The post-session pass (apps/ai app/session_recordings.py) joins each part's slices into
-- recordings/<session>/<part>/whole for Gemini to watch, and removes it when it's done.
-- A pass killed in between (a redeploy, a failed compose) leaves that copy of the whole
-- recording behind. It's queued for deletion with its part instead, however the part goes
-- (its session deleted or expired, the workspace or member gone), like the part's slices.
-- Not when the pass starts: the hourly files cleanup could then delete it while Gemini
-- is still reading it.
CREATE OR REPLACE FUNCTION app.queue_recording_part_deletion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO files.object_deletion (key)
  VALUES ('recordings/' || OLD.session_id || '/' || OLD.index || '/whole')
  ON CONFLICT (key) DO NOTHING;
  RETURN OLD;
END $$;

-- Only the trigger calls it.
REVOKE EXECUTE ON FUNCTION app.queue_recording_part_deletion() FROM PUBLIC;

CREATE TRIGGER queue_recording_part_deletion AFTER DELETE ON app.recording_part
  FOR EACH ROW EXECUTE FUNCTION app.queue_recording_part_deletion();
