-- Fail fast instead of queueing behind long transactions: a migration that cannot take
-- its locks within 5s aborts, rather than blocking every query on the table meanwhile.
SET lock_timeout = '5s';

-- Functions use CREATE OR REPLACE: `prisma migrate dev` replays migrations into the
-- shadow database more than once per run, and its reset in between keeps functions.

-- ---------------------------------------------------------------------------- audit log

CREATE SCHEMA IF NOT EXISTS "audit";

-- Partitioned by month; partitions are created and dropped by the functions below.
CREATE TABLE "audit"."audit_log" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "org_id" UUID,
    "actor_id" UUID,
    "request_id" TEXT,
    "source" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id","occurred_at")
) PARTITION BY RANGE ("occurred_at");

CREATE INDEX "audit_log_org_id_occurred_at_idx" ON "audit"."audit_log"("org_id", "occurred_at" DESC);

-- Monthly partitions audit_log_YYYY_MM from `months_back` months ago to `months_ahead`
-- months from now. Idempotent; the worker runs it at boot and daily.
CREATE OR REPLACE FUNCTION audit.ensure_partitions(months_back int, months_ahead int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  month date;
  created int := 0;
  partition_name text;
BEGIN
  FOR i IN -months_back..months_ahead LOOP
    month := (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => i))::date;
    partition_name := format('audit_log_%s', to_char(month, 'YYYY_MM'));
    IF to_regclass(format('audit.%I', partition_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE audit.%I PARTITION OF audit.audit_log FOR VALUES FROM (%L) TO (%L)',
        partition_name, month::timestamptz, (month + interval '1 month')::timestamptz
      );
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END $$;

-- Drops whole months that ended before `cutoff`: retention without row-by-row deletes.
CREATE OR REPLACE FUNCTION audit.drop_partitions_before(cutoff timestamptz) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  partition record;
  dropped int := 0;
BEGIN
  FOR partition IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'audit.audit_log'::regclass AND c.relname ~ '^audit_log_\d{4}_\d{2}$'
  LOOP
    IF (to_date(substr(partition.relname, 11), 'YYYY_MM') + interval '1 month') <= cutoff THEN
      EXECUTE format('DROP TABLE audit.%I', partition.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END $$;

-- Row-level security: an organization's admins read only its events (apps/api sets
-- app.org_id per query, like every tenant table). Events without an organization
-- (account security) are only visible to operators with direct database access.
ALTER TABLE audit.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON audit.audit_log FOR SELECT
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY worker_append ON audit.audit_log FOR INSERT TO app_worker WITH CHECK (true);

-- Append-only by privilege: the worker inserts, the api reads; nobody updates or deletes.
GRANT USAGE ON SCHEMA audit TO app_worker, app_api;
GRANT INSERT ON audit.audit_log TO app_worker;
GRANT SELECT ON audit.audit_log TO app_api;

-- ---------------------------------------------------------------------------- retention

-- Published outbox rows are kept for a while so events can be replayed to a consumer,
-- then deleted in batches (short transactions; no long lock on a busy table).
CREATE OR REPLACE FUNCTION app.purge_published_outbox(older_than interval) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  total bigint := 0;
  batch bigint;
BEGIN
  LOOP
    DELETE FROM app.outbox_event WHERE id IN (
      SELECT id FROM app.outbox_event
      WHERE published_at < now() - older_than
      LIMIT 5000
    );
    GET DIAGNOSTICS batch = ROW_COUNT;
    total := total + batch;
    EXIT WHEN batch < 5000;
  END LOOP;
  RETURN total;
END $$;

-- Consumers' dedupe records only need to outlive the longest possible redelivery.
CREATE OR REPLACE FUNCTION app.purge_processed_events(older_than interval) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  removed bigint;
BEGIN
  DELETE FROM app.processed_event WHERE processed_at < now() - older_than;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

-- Sessions and verification codes live in Redis with a TTL; these are the database
-- copies (device list, fallback), which nothing else expires.
CREATE OR REPLACE FUNCTION auth.purge_expired() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  sessions bigint;
  verifications bigint;
BEGIN
  DELETE FROM auth.session WHERE expires_at < now();
  GET DIAGNOSTICS sessions = ROW_COUNT;
  DELETE FROM auth.verification WHERE expires_at < now();
  GET DIAGNOSTICS verifications = ROW_COUNT;
  RETURN sessions + verifications;
END $$;

-- Functions are executable by PUBLIC by default; only the worker may run these.
REVOKE EXECUTE ON FUNCTION
  audit.ensure_partitions(int, int),
  audit.drop_partitions_before(timestamptz),
  app.purge_published_outbox(interval),
  app.purge_processed_events(interval),
  auth.purge_expired()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  audit.ensure_partitions(int, int),
  audit.drop_partitions_before(timestamptz),
  app.purge_published_outbox(interval),
  app.purge_processed_events(interval),
  auth.purge_expired()
TO app_worker;
GRANT USAGE ON SCHEMA auth TO app_worker;
