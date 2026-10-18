SET lock_timeout = '5s';

-- Director's demo gives each browser its own guest (apps/api/src/auth/guest.ts) instead of
-- one account everyone shares: a user like any other, with its own personal workspace and
-- the seeded templates, flagged `demo` (so the demo's restrictions apply) and with this
-- column set to when it's deleted, 24 hours after it was made. So judges never see each
-- other's footage, and nothing they film outlives the day.
--
-- Expand only: a nullable column with no default adds nothing to existing rows and
-- rewrites nothing, and the previous release never reads it.
ALTER TABLE "auth"."user" ADD COLUMN "guest_until" TIMESTAMPTZ(3);

-- ---------------------------------------------------------------------------- retention
-- Deletes the guests whose time is up, at most `max_guests` of them a call (the worker
-- calls it hourly, and again while it returns a full batch), and returns how many. Each
-- goes the way account deletion does: the workspaces it alone belongs to first (tenant
-- tables cascade from auth.organization: its plans, takes and cuts), then the user
-- (sessions, accounts, memberships and files cascade from it). Every deleted file row
-- queues its objects in files.object_deletion (that table's trigger), which the worker's
-- files cleanup then removes from storage.
--
-- A guest's session ends when it does (the API gives it no longer), so nothing signed in
-- is left pointing at what this deletes. SKIP LOCKED: a guest some other transaction is
-- changing waits for the next run instead of blocking this one.
--
-- auth.user, auth.organization and auth.member have no row-level security; the tenant
-- and files tables do, but Postgres runs the cascades as each table's owner, past it.
CREATE OR REPLACE FUNCTION auth.purge_expired_guests(max_guests integer) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  expired uuid[];
  deleted bigint;
BEGIN
  SELECT coalesce(array_agg(id), '{}') INTO expired FROM (
    SELECT id FROM auth."user"
     WHERE guest_until IS NOT NULL AND guest_until <= now()
     ORDER BY guest_until
     LIMIT max_guests
       FOR UPDATE SKIP LOCKED
  ) AS due;

  DELETE FROM auth.organization AS workspace
   WHERE EXISTS (
           SELECT 1 FROM auth.member AS m
            WHERE m.organization_id = workspace.id AND m.user_id = ANY (expired)
         )
     AND NOT EXISTS (
           SELECT 1 FROM auth.member AS m
            WHERE m.organization_id = workspace.id AND m.user_id <> ALL (expired)
         );

  DELETE FROM auth."user" WHERE id = ANY (expired);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END $$;

REVOKE EXECUTE ON FUNCTION auth.purge_expired_guests(integer) FROM PUBLIC;
-- apps/worker runs it (the maintenance task demo-guests); it already has USAGE on auth.
GRANT EXECUTE ON FUNCTION auth.purge_expired_guests(integer) TO app_worker;
