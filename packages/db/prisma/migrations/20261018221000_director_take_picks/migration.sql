SET lock_timeout = '5s';

-- Director's picks with reasons (the editor shows its pick first, with a line on why),
-- the member's own choice made while shooting ("use the second one"), and takes the
-- post-session pass finds in the whole recording after Done (a great line said while
-- rehearsing).
--
-- Expand only: nullable columns and one with a constant default, which Postgres adds
-- without rewriting the table. The previous release never reads or writes them. The
-- table's row-level security and grants (apps/ai owns it) cover new columns as they are.
ALTER TABLE ai.director_take
  ADD COLUMN reason text,
  ADD COLUMN chosen_at timestamptz(3),
  ADD COLUMN origin text NOT NULL DEFAULT 'shoot';

-- The post-session pass (apps/ai app/session_pass.py) goes through a finished recording
-- session after Done: it reads the session's parts, slices and attempts, and adds the
-- attempts the live marks missed, which apps/worker then cuts into takes like any other.
-- An attempt it adds says so (origin 'pass') and carries Gemini's reason, which the take
-- cut from it shows in the editor. Expand only: a defaulted and a nullable column.
ALTER TABLE app.recording_attempt
  ADD COLUMN origin text NOT NULL DEFAULT 'shoot',
  ADD COLUMN reason text;

-- The AI service reads what the pass needs and adds attempts, nothing more: no update or
-- delete, and row-level security holds it to the workspace in app.org_id. It reads the
-- attempt a take's file was cut from too, to mark a take the pass found.
GRANT USAGE ON SCHEMA app TO app_ai;
GRANT SELECT ON app.recording_session, app.recording_part, app.recording_slice,
  app.recording_attempt TO app_ai;
GRANT INSERT (org_id, session_id, number, shot_index, part_index, line, start_ms, end_ms,
  status, origin, reason, updated_at) ON app.recording_attempt TO app_ai;
