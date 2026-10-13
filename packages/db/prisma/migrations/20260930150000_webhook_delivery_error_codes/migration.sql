-- Delivery errors are codes now (WEBHOOK_DELIVERY_ERRORS in @repo/contracts), not the
-- error messages that were stored before, which tenants could see. Old rows get the
-- nearest code: an HTTP answer keeps just its status (last_status).
SET lock_timeout = '5s';
UPDATE webhooks.delivery
   SET last_error = CASE
     WHEN last_error = 'endpoint disabled' THEN 'endpoint_disabled'
     WHEN last_error LIKE 'HTTP %' THEN NULL
     ELSE 'connection_failed'
   END
 WHERE last_error IS NOT NULL
   AND last_error NOT IN ('timeout', 'connection_failed', 'destination_not_allowed',
                          'response_too_large', 'endpoint_disabled');
