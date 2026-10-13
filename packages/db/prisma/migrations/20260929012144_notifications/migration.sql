-- Fail fast instead of queueing behind long transactions: a migration that cannot take
-- its locks within 5s aborts, rather than blocking every query on the table meanwhile.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "notifications";

-- CreateTable
CREATE TABLE "notifications"."notification" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "org_id" UUID,
    "template" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "link" TEXT,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications"."delivery" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "idempotency_key" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "user_id" UUID,
    "status" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications"."preference" (
    "user_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,

    CONSTRAINT "preference_pkey" PRIMARY KEY ("user_id","category","channel")
);

-- CreateTable
CREATE TABLE "notifications"."settings" (
    "user_id" UUID NOT NULL,
    "quiet_start" SMALLINT,
    "quiet_end" SMALLINT,
    "daily_digest" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "notifications"."digest_item" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "template" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "digest_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications"."suppression" (
    "channel" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppression_pkey" PRIMARY KEY ("channel","address")
);

-- CreateTable
CREATE TABLE "notifications"."device" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "app_version" TEXT,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_user_id_id_idx" ON "notifications"."notification"("user_id", "id" DESC);

-- CreateIndex
CREATE INDEX "notification_unread_idx" ON "notifications"."notification"("user_id") WHERE (read_at IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_idempotency_key_key" ON "notifications"."delivery"("idempotency_key");

-- CreateIndex
CREATE INDEX "delivery_user_id_created_at_idx" ON "notifications"."delivery"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "digest_item_user_id_created_at_idx" ON "notifications"."digest_item"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "device_token_key" ON "notifications"."device"("token");

-- CreateIndex
CREATE INDEX "device_user_id_idx" ON "notifications"."device"("user_id");

-- AddForeignKey
ALTER TABLE "notifications"."notification" ADD CONSTRAINT "notification_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications"."preference" ADD CONSTRAINT "preference_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications"."settings" ADD CONSTRAINT "settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications"."digest_item" ADD CONSTRAINT "digest_item_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications"."device" ADD CONSTRAINT "device_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------- per-user rows

-- A user's inbox, preferences, settings, devices and digest queue: every role (the
-- notification service included) sees only the user in app.user_id (set by withUser).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification', 'preference', 'settings', 'device', 'digest_item'] LOOP
    EXECUTE format('ALTER TABLE notifications.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE notifications.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY own_rows ON notifications.%I
         USING (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)
         WITH CHECK (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------- privileges

GRANT USAGE ON SCHEMA notifications TO app_api, app_notifications, app_worker;

-- apps/notifications: creates inbox rows and digests, logs deliveries, records
-- suppressions, prunes dead devices; reads what users configured.
GRANT SELECT, INSERT ON notifications.notification TO app_notifications;
GRANT SELECT, INSERT, UPDATE ON notifications.delivery TO app_notifications;
GRANT SELECT ON notifications.preference, notifications.settings TO app_notifications;
GRANT SELECT, INSERT, DELETE ON notifications.digest_item TO app_notifications;
GRANT SELECT, INSERT ON notifications.suppression TO app_notifications;
GRANT SELECT, DELETE ON notifications.device TO app_notifications;
GRANT UPDATE (last_seen_at) ON notifications.device TO app_notifications;
-- Organization roles, to notify a workspace's admins.
GRANT SELECT (organization_id, user_id, role) ON auth.member TO app_notifications;

-- apps/api: what users control from the app.
GRANT SELECT ON notifications.notification TO app_api;
GRANT UPDATE (read_at) ON notifications.notification TO app_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications.preference, notifications.settings, notifications.device TO app_api;

-- ---------------------------------------------------------------------------- retention
-- CREATE OR REPLACE: `prisma migrate dev` replays migrations into the shadow database
-- more than once per run, and its reset in between keeps functions.

CREATE OR REPLACE FUNCTION notifications.purge_history(older_than interval) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  total bigint := 0;
  batch bigint;
BEGIN
  LOOP
    DELETE FROM notifications.delivery WHERE id IN (
      SELECT id FROM notifications.delivery WHERE created_at < now() - older_than LIMIT 5000
    );
    GET DIAGNOSTICS batch = ROW_COUNT;
    total := total + batch;
    EXIT WHEN batch < 5000;
  END LOOP;
  -- Read in-app notifications past the window; unread ones stay until read.
  DELETE FROM notifications.notification WHERE read_at IS NOT NULL AND read_at < now() - older_than;
  GET DIAGNOSTICS batch = ROW_COUNT;
  RETURN total + batch;
END $$;

REVOKE EXECUTE ON FUNCTION notifications.purge_history(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notifications.purge_history(interval) TO app_worker;
