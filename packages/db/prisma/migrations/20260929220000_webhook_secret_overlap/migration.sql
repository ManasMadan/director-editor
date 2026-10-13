-- Fail fast instead of queueing behind long transactions: a migration that cannot take
-- its locks within 5s aborts, rather than blocking every query on the table meanwhile.
SET lock_timeout = '5s';

-- A rotated signing secret keeps signing, alongside the new one, until it expires, so
-- customers can switch their receivers without dropping deliveries. Nullable columns:
-- no rewrite, and the running release ignores them. The api's and webhooks' existing
-- table grants cover them.
ALTER TABLE webhooks.endpoint
  ADD COLUMN previous_secret TEXT,
  ADD COLUMN previous_secret_expires_at TIMESTAMPTZ(3);
