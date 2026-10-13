-- Push devices belong to the session that registered them: signing out, or a session
-- revoked from another device, deletes the session and with it the device, so pushes
-- never outlive the sign-in they were meant for. Devices registered before this simply
-- register again on the app's next start.
DELETE FROM "notifications"."device";

ALTER TABLE "notifications"."device" ADD COLUMN "session_id" UUID NOT NULL;
CREATE INDEX "device_session_id_idx" ON "notifications"."device"("session_id");
ALTER TABLE "notifications"."device" ADD CONSTRAINT "device_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auth"."session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE notifications.device
  ADD CONSTRAINT device_platform_check CHECK (platform IN ('ios', 'android', 'web'));

-- SECURITY DEFINER functions run as the tables' owner (migrator), which forced row-level
-- security still applies to. The owner could turn RLS off anyway, so this policy grants
-- nothing new; it lets register_device, and notifications.purge_history, see every row.
CREATE POLICY owner_functions ON notifications.device TO migrator USING (true) WITH CHECK (true);
CREATE POLICY owner_functions ON notifications.notification TO migrator USING (true) WITH CHECK (true);

-- A push token belongs to a device, not an account: when someone else signs in on the
-- same phone or browser, the token must move to them, or the previous user's pushes
-- would land on a device they no longer use. Row-level security hides the previous
-- owner's row from apps/api, so the move happens here, and only for the user in
-- app.user_id and a session of theirs.
CREATE OR REPLACE FUNCTION notifications.register_device(
  device_platform text,
  device_token text,
  device_app_version text,
  device_session uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  owner uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  device_id uuid;
BEGIN
  IF owner IS NULL THEN
    RAISE EXCEPTION 'register_device needs app.user_id' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.session WHERE id = device_session AND user_id = owner) THEN
    RAISE EXCEPTION 'session % is not the user''s', device_session USING ERRCODE = '42501';
  END IF;
  INSERT INTO notifications.device (user_id, session_id, platform, token, app_version)
  VALUES (owner, device_session, device_platform, device_token, device_app_version)
  ON CONFLICT (token) DO UPDATE
    SET user_id = excluded.user_id,
        session_id = excluded.session_id,
        platform = excluded.platform,
        app_version = excluded.app_version,
        last_seen_at = now()
  RETURNING id INTO device_id;
  RETURN device_id;
END $$;

REVOKE EXECUTE ON FUNCTION notifications.register_device(text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notifications.register_device(text, text, text, uuid) TO app_api;
