SET lock_timeout = '5s';

-- Every workspace starts with Director's 6 seeded templates in its library. apps/api
-- copies them in the same transaction that creates the workspace
-- (apps/api/src/modules/director/seeds.repository.ts), so a workspace never exists
-- without them, and its backfill command copies them into workspaces made before. The
-- copy can't go through the AI service, which owns ai.director_plan: that would be an
-- HTTP call inside the workspace's transaction, from a connection that can't see the
-- uncommitted workspace its rows point at.
--
-- So the API gets exactly what copying a seed takes and nothing else of the table: it
-- inserts these columns only (not created_by, so a copy is in nobody's name and never
-- anyone's one index, and not error; created_at because Prisma sends its own timestamp
-- rather than leave it to the default), it can't read, update or delete a plan, and the
-- restrictive policy below makes every row it inserts a seed. Row-level security still
-- holds it to the workspace in app.org_id.
--
-- Only privileges and a policy: the previous release never uses them.
GRANT INSERT (org_id, video_id, source, status, stage, plan, model, audio_status, audio_key, created_at, updated_at)
  ON ai.director_plan TO app_api;

CREATE POLICY api_inserts_seeds_only ON ai.director_plan AS RESTRICTIVE FOR INSERT TO app_api
  WITH CHECK (source = 'seed' AND created_by IS NULL);
