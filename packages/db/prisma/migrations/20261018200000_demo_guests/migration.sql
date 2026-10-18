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

-- ---------------------------------------------------------------------------- cost record
-- What deleted guests spent on models, by month, feature and model. A guest's ai.usage
-- rows go with its workspace (they cascade from auth.organization), so the purge below
-- adds them up here first, and the demo's cost stays on record. Not a tenant table: it
-- holds no workspace's rows, only the demo's totals.
CREATE TABLE "ai"."demo_usage" (
    "month" DATE NOT NULL,
    "feature" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "demo_usage_pkey" PRIMARY KEY ("month", "feature", "model")
);

-- ---------------------------------------------------------------------------- retention
-- Deletes the guests whose time is up, at most `max_guests` of them a call (the worker
-- calls it hourly, and again while it returns a full batch), and returns each one with its
-- sessions' tokens, so the worker can drop them from Valkey, where better-auth looks
-- sessions up first. Each goes the way account deletion does: the workspaces it alone
-- belongs to first, their model usage added to ai.demo_usage (tenant tables cascade from
-- auth.organization: its plans, takes, cuts and usage), then the user (sessions,
-- accounts, memberships and files cascade from it). Every deleted file row queues its
-- objects in files.object_deletion (that table's trigger), which the worker's files
-- cleanup then removes from storage.
--
-- SKIP LOCKED: a guest some other transaction is changing waits for the next run instead
-- of blocking this one. auth.user, auth.organization and auth.member have no row-level
-- security; ai.usage does, and the policy below lets this function read it. The
-- cascades run as referential actions, past row-level security.
CREATE OR REPLACE FUNCTION auth.purge_expired_guests(max_guests integer)
RETURNS TABLE (guest_id uuid, session_tokens text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  expired uuid[];
  workspaces uuid[];
BEGIN
  SELECT coalesce(array_agg(due.id), '{}') INTO expired FROM (
    SELECT u.id FROM auth."user" AS u
     WHERE u.guest_until IS NOT NULL AND u.guest_until <= now()
     ORDER BY u.guest_until
     LIMIT max_guests
       FOR UPDATE SKIP LOCKED
  ) AS due;

  -- The workspaces only expired guests belong to.
  SELECT coalesce(array_agg(o.id), '{}') INTO workspaces FROM auth.organization AS o
   WHERE EXISTS (
           SELECT 1 FROM auth.member AS m
            WHERE m.organization_id = o.id AND m.user_id = ANY (expired)
         )
     AND NOT EXISTS (
           SELECT 1 FROM auth.member AS m
            WHERE m.organization_id = o.id AND m.user_id <> ALL (expired)
         );

  INSERT INTO ai.demo_usage AS total (month, feature, model, input_tokens, output_tokens)
  SELECT date_trunc('month', usage.created_at AT TIME ZONE 'UTC')::date, usage.feature,
         usage.model, sum(usage.input_tokens), sum(usage.output_tokens)
    FROM ai.usage AS usage
   WHERE usage.org_id = ANY (workspaces)
   GROUP BY 1, 2, 3
  ON CONFLICT (month, feature, model) DO UPDATE
     SET input_tokens = total.input_tokens + excluded.input_tokens,
         output_tokens = total.output_tokens + excluded.output_tokens;

  DELETE FROM auth.organization AS o WHERE o.id = ANY (workspaces);

  -- Read before the user goes, and its sessions with it.
  RETURN QUERY
    SELECT gone.id,
           coalesce(array_agg(s.token) FILTER (WHERE s.token IS NOT NULL), '{}')
      FROM unnest(expired) AS gone(id)
      LEFT JOIN auth.session AS s ON s.user_id = gone.id
     GROUP BY gone.id;

  DELETE FROM auth."user" AS u WHERE u.id = ANY (expired);
END $$;

REVOKE EXECUTE ON FUNCTION auth.purge_expired_guests(integer) FROM PUBLIC;
-- apps/worker runs it (the maintenance task demo-retention); it already has USAGE on auth.
GRANT EXECUTE ON FUNCTION auth.purge_expired_guests(integer) TO app_worker;

-- The shared demo account (the fallback when no guest can be made) keeps its footage for
-- a day too: its takes' and videos' files older than `older_than` are deleted (the takes
-- and cuts cascade from them, and the files' objects are queued for removal from storage
-- by the trigger). Its library stays: it's the seeds and the one Short it indexed.
-- Returns how many files went.
CREATE OR REPLACE FUNCTION files.purge_demo_footage(older_than interval) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  deleted bigint;
BEGIN
  DELETE FROM files.file AS f
   USING auth."user" AS u
   WHERE f.user_id = u.id
     AND u.demo AND u.guest_until IS NULL
     AND f.purpose IN ('director-take-video', 'director-take-photo', 'director-cut-video')
     AND f.created_at < now() - older_than;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END $$;

REVOKE EXECUTE ON FUNCTION files.purge_demo_footage(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION files.purge_demo_footage(interval) TO app_worker;

-- ---------------------------------------------------------------------------- allowance
-- Whether a workspace is a demo guest's, for the AI service, which gives a guest's
-- workspace a smaller monthly token allowance (AI_MONTHLY_TOKENS_PER_DEMO_GUEST). It sees
-- one workspace at a time and may not read auth.user; this answers only yes or no.
CREATE OR REPLACE FUNCTION ai.demo_guest_workspace(workspace uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.member AS m
      JOIN auth."user" AS u ON u.id = m.user_id
     WHERE m.organization_id = workspace AND u.guest_until IS NOT NULL
  );
$$;
REVOKE EXECUTE ON FUNCTION ai.demo_guest_workspace(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.demo_guest_workspace(uuid) TO app_ai;

-- ---------------------------------------------------------------------------- policies
-- SECURITY DEFINER functions run as the tables' owner (migrator), which forced row-level
-- security still applies to. The owner could turn it off anyway, so these grant nothing
-- new; they're as narrow as the functions need, so the migrator otherwise still sees one
-- workspace (or user) at a time: the guests' purge reads expired guests' usage, and the
-- footage purge deletes the shared demo account's files with no user in app.user_id.
CREATE POLICY owner_functions ON ai.usage FOR SELECT TO migrator USING (
  EXISTS (
    SELECT 1 FROM auth.member AS m
      JOIN auth."user" AS u ON u.id = m.user_id
     WHERE m.organization_id = usage.org_id AND u.guest_until <= now()
  )
);
CREATE POLICY owner_functions ON files.file TO migrator
  USING (EXISTS (
    SELECT 1 FROM auth."user" AS u
     WHERE u.id = file.user_id AND u.demo AND u.guest_until IS NULL
  ));
