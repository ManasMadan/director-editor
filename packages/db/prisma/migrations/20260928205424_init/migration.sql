-- Fail fast instead of queueing behind long transactions: a migration that cannot take
-- its locks within 5s aborts, rather than blocking every query on the table meanwhile.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "app";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "auth";

-- CreateTable
CREATE TABLE "app"."todo" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "todo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."outbox_event" (
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
CREATE TABLE "app"."processed_event" (
    "event_id" UUID NOT NULL,
    "consumer" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_event_pkey" PRIMARY KEY ("event_id","consumer")
);

-- CreateTable
CREATE TABLE "auth"."user" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."session" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "token" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."account" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(3),
    "refresh_token_expires_at" TIMESTAMPTZ(3),
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."verification" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "todo_org_id_id_idx" ON "app"."todo"("org_id", "id" DESC);

-- CreateIndex
CREATE INDEX "outbox_event_unpublished_idx" ON "app"."outbox_event"("occurred_at") WHERE (published_at IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "auth"."user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "auth"."session"("token");

-- CreateIndex
CREATE INDEX "session_user_id_idx" ON "auth"."session"("user_id");

-- CreateIndex
CREATE INDEX "account_user_id_idx" ON "auth"."account"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_provider_id_account_id_key" ON "auth"."account"("provider_id", "account_id");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "auth"."verification"("identifier");

-- AddForeignKey
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."account" ADD CONSTRAINT "account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Access control. Roles are created by the environment bootstrap (see
-- infra/postgres/init), never here. Each service gets exactly what it needs.
-- ---------------------------------------------------------------------------

-- apps/api owns auth and app: full data access, and automatically to future tables.
GRANT USAGE ON SCHEMA auth, app TO app_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth, app TO app_api;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA auth, app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_api;

-- apps/notifications reads identity only (who to send to, in which language and zone).
GRANT USAGE ON SCHEMA auth TO app_notifications;
GRANT SELECT (id, name, email, locale, timezone) ON auth."user" TO app_notifications;

-- apps/worker relays api's outbox: read events, stamp them published, nothing else.
GRANT USAGE ON SCHEMA app TO app_worker;
GRANT SELECT ON app.outbox_event TO app_worker;
GRANT UPDATE (published_at) ON app.outbox_event TO app_worker;

-- ---------------------------------------------------------------------------
-- Tenant isolation. A row is visible only when its org_id matches the
-- transaction-local `app.org_id` (set by withTenant/tenantTx in packages/db).
-- FORCE applies the policy to the table owner too. nullif() keeps the policy valid
-- when the setting is unset: after a transaction ends it resets to '' (not NULL),
-- and ''::uuid would raise instead of matching nothing.
-- ---------------------------------------------------------------------------
ALTER TABLE app.todo ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.todo FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.todo
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
