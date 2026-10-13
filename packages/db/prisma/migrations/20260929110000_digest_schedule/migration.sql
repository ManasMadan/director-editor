-- The hourly digest run needs to know which users have items waiting, across users,
-- which row-level security hides from apps/notifications. This function answers only
-- that (user ids, nothing else); the digest itself is read per user, under their scope.
CREATE POLICY owner_functions ON notifications.digest_item TO migrator USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION notifications.users_with_digest_items() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT DISTINCT user_id FROM notifications.digest_item
$$;

REVOKE EXECUTE ON FUNCTION notifications.users_with_digest_items() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notifications.users_with_digest_items() TO app_notifications;
