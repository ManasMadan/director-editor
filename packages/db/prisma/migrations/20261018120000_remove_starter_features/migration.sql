-- Director keeps only the starter features it uses, and drops the tables and the column
-- of the ones it removed (todos, the documents assistant, MCP and its OAuth provider, API
-- keys, billing, outbound webhooks, in-app and push notifications, phone numbers) in one
-- step rather than expand then contract. Production holds no data in any of them, so
-- nothing is lost; the cost is that pods of the previous release may error on them until
-- the rollout replaces those pods.
SET lock_timeout = '5s';

-- Functions over the dropped tables go first; the purges keep their names and grants
-- (apps/worker calls them) and now cover only what is left.
DROP FUNCTION auth.mcp_grant_active(text, uuid, uuid);
DROP FUNCTION notifications.register_device(text, text, text, uuid);
DROP FUNCTION notifications.users_with_digest_items();

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

-- The email delivery log, in batches.
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
  RETURN total;
END $$;

-- Received provider events (the mail server's) past the window.
CREATE OR REPLACE FUNCTION webhooks.purge_history(older_than interval) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  removed bigint;
BEGIN
  DELETE FROM webhooks.inbound_event WHERE received_at < now() - older_than;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

-- Access only the removed features needed: the AI service read auth for the MCP grant
-- check, the notification service read memberships to find a workspace's admins, and
-- the API edited notification preferences and webhook endpoints.
REVOKE USAGE ON SCHEMA auth FROM app_ai;
REVOKE SELECT (organization_id, user_id, role) ON auth.member FROM app_notifications;
REVOKE USAGE ON SCHEMA notifications, webhooks FROM app_api;

-- Empty in production; the previous release's pods may error on them until replaced.
-- squawk-ignore ban-drop-table
DROP TABLE
  ai.chunk,
  ai.document,
  app.todo,
  auth.api_key,
  auth.jwks,
  auth.oauth_access_token,
  auth.oauth_refresh_token,
  auth.oauth_consent,
  auth.oauth_client_resource,
  auth.oauth_client,
  auth.oauth_resource,
  auth.oauth_client_assertion,
  billing.customer,
  billing.subscription,
  billing.trial_card,
  notifications.notification,
  notifications.preference,
  notifications.settings,
  notifications.digest_item,
  notifications.device,
  webhooks.delivery,
  webhooks.endpoint;

DROP SCHEMA billing;

-- Empty in production (phone numbers went with SMS); the previous release's pods may
-- error on it until replaced.
-- squawk-ignore ban-drop-column
ALTER TABLE auth."user" DROP COLUMN phone_number;
