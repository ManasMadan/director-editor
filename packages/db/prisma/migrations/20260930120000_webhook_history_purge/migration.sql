-- webhooks.purge_history runs as its owner (migrator), and FORCE ROW LEVEL SECURITY
-- applies to owners too: with no tenant set, its DELETE matched no delivery, so the log
-- (whole event bodies) grew forever. The owner's own policy lets the function see them,
-- as notifications' purge functions already do.
SET lock_timeout = '5s';
CREATE POLICY owner_functions ON webhooks.delivery TO migrator USING (true) WITH CHECK (true);
