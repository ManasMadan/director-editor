-- Fail fast instead of queueing behind long transactions: a migration that cannot take
-- its locks within 5s aborts, rather than blocking every query on the table meanwhile.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "webhooks";

-- CreateTable
CREATE TABLE "webhooks"."endpoint" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "events" TEXT[],
    "secret" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "disabled_at" TIMESTAMPTZ(3),
    "disabled_reason" TEXT,

    CONSTRAINT "endpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks"."delivery" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "endpoint_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event_name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMPTZ(3),
    "last_status" INTEGER,
    "last_error" TEXT,
    "last_duration_ms" INTEGER,
    "succeeded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks"."inbound_event" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "provider" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks"."outbox_event" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "org_id" UUID,
    "actor_id" UUID,
    "request_id" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks"."processed_event" (
    "event_id" UUID NOT NULL,
    "consumer" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_event_pkey" PRIMARY KEY ("event_id","consumer")
);

-- CreateIndex
CREATE INDEX "endpoint_org_id_idx" ON "webhooks"."endpoint"("org_id");

-- CreateIndex
CREATE INDEX "delivery_endpoint_id_id_idx" ON "webhooks"."delivery"("endpoint_id", "id" DESC);

-- CreateIndex
CREATE INDEX "delivery_org_id_idx" ON "webhooks"."delivery"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_endpoint_id_event_id_key" ON "webhooks"."delivery"("endpoint_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_event_provider_provider_event_id_key" ON "webhooks"."inbound_event"("provider", "provider_event_id");

-- CreateIndex
CREATE INDEX "webhooks_outbox_event_unpublished_idx" ON "webhooks"."outbox_event"("occurred_at") WHERE (published_at IS NULL);

-- AddForeignKey
ALTER TABLE "webhooks"."endpoint" ADD CONSTRAINT "endpoint_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks"."delivery" ADD CONSTRAINT "delivery_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhooks"."endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------- tenancy

-- Endpoints and deliveries belong to an organization. Every role, the webhooks service
-- included, sees only the organization in app.org_id.
ALTER TABLE webhooks.endpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks.endpoint FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhooks.endpoint
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE webhooks.delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks.delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhooks.delivery
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- ---------------------------------------------------------------------------- privileges

GRANT USAGE ON SCHEMA webhooks TO app_api, app_webhooks, app_worker;

-- apps/api manages endpoint configuration for org admins and reads the delivery log.
GRANT SELECT, INSERT, UPDATE, DELETE ON webhooks.endpoint TO app_api;
GRANT SELECT ON webhooks.delivery TO app_api;

-- apps/webhooks reads endpoints, may only disable one, and owns everything else here.
GRANT SELECT ON webhooks.endpoint TO app_webhooks;
GRANT UPDATE (disabled_at, disabled_reason, updated_at) ON webhooks.endpoint TO app_webhooks;
GRANT SELECT, INSERT, UPDATE ON webhooks.delivery TO app_webhooks;
GRANT SELECT, INSERT ON webhooks.inbound_event TO app_webhooks;
GRANT SELECT, INSERT, UPDATE, DELETE ON webhooks.outbox_event, webhooks.processed_event TO app_webhooks;

-- apps/worker relays this schema's outbox (see apps/worker/src/outbox/sources.ts).
GRANT SELECT ON webhooks.outbox_event TO app_worker;
GRANT UPDATE (published_at) ON webhooks.outbox_event TO app_worker;

-- ---------------------------------------------------------------------------- retention
-- CREATE OR REPLACE: `prisma migrate dev` replays migrations into the shadow database
-- more than once per run, and its reset in between keeps functions.

CREATE OR REPLACE FUNCTION webhooks.purge_published_outbox(older_than interval) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  total bigint := 0;
  batch bigint;
BEGIN
  LOOP
    DELETE FROM webhooks.outbox_event WHERE id IN (
      SELECT id FROM webhooks.outbox_event WHERE published_at < now() - older_than LIMIT 5000
    );
    GET DIAGNOSTICS batch = ROW_COUNT;
    total := total + batch;
    EXIT WHEN batch < 5000;
  END LOOP;
  RETURN total;
END $$;

CREATE OR REPLACE FUNCTION webhooks.purge_processed_events(older_than interval) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  removed bigint;
BEGIN
  DELETE FROM webhooks.processed_event WHERE processed_at < now() - older_than;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

-- Delivery logs and received provider events are kept for a window, then deleted in
-- batches; finished deliveries only (pending ones may still be retrying).
CREATE OR REPLACE FUNCTION webhooks.purge_history(older_than interval) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  total bigint := 0;
  batch bigint;
BEGIN
  LOOP
    DELETE FROM webhooks.delivery WHERE id IN (
      SELECT id FROM webhooks.delivery
      WHERE created_at < now() - older_than AND status <> 'pending'
      LIMIT 5000
    );
    GET DIAGNOSTICS batch = ROW_COUNT;
    total := total + batch;
    EXIT WHEN batch < 5000;
  END LOOP;
  DELETE FROM webhooks.inbound_event WHERE received_at < now() - older_than;
  GET DIAGNOSTICS batch = ROW_COUNT;
  RETURN total + batch;
END $$;

REVOKE EXECUTE ON FUNCTION
  webhooks.purge_published_outbox(interval),
  webhooks.purge_processed_events(interval),
  webhooks.purge_history(interval)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  webhooks.purge_published_outbox(interval),
  webhooks.purge_processed_events(interval),
  webhooks.purge_history(interval)
TO app_worker;
