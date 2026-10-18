# Notifications

apps/notifications sends every email a user receives: sign-in codes and security
alerts. Other services never send anything themselves; they queue a notification job,
or ask for one through the outbox.

## How a notification flows

1. A producer adds a `send` job to `notifications-critical`
   (`notificationPayload` in `packages/jobs/src/queues.ts`); sign-in codes go this way.
   A notification that must not be lost goes out with the change it's about instead:
   `requestNotification(tx, …)` (`apps/api/src/notifications.ts`) writes it to the
   outbox in the change's transaction, as `notification.requested.v1`, and this service
   sends it from `events-notifications`. Security alerts go this way: Redis being down
   delays one, never drops it, and a change that rolls back sends none.
2. The dispatcher (`apps/notifications/src/dispatch/dispatcher.ts`) binds the template
   to the recipient's address and language, then:
   - claims the delivery in the delivery log (`notifications.delivery`), keyed on the
     job id and the address, so retries and redelivered events never double-send;
   - skips an address on the suppression list;
   - sends, and records the outcome (`sent`, `suppressed`, `failed`).
3. A failed send throws, and BullMQ retries the job with the queue's backoff.

Everything is rendered in the recipient's language from `packages/i18n`.

## Email

SMTP submission to our Stalwart mail server (Mailpit locally), behind `EmailTransport`
(`channels/email/email-transport.ts`), configured by `SMTP_URL` and `EMAIL_FROM`
([environment.md](environment.md)). Another provider is another transport class,
registered in the channel's module; the dispatcher doesn't change.

| Template | Sent when |
|---|---|
| `auth.otp` | sign-up verification, sign-in by code, password reset, email change |
| `auth.security-alert` | a sensitive account change ([auth.md](auth.md)) |

Templates are defined in code (`apps/notifications/src/dispatch/templates.ts`) and
reached only through `TemplateSource`, so they can later move to a database (editable
copy, per-tenant branding) by binding another implementation in
`notifications.module.ts`. Email bodies are React Email components in
`packages/email/src/templates`; preview them with `bun run --cwd packages/email dev`
(http://localhost:3030).

## Suppression

`notifications.suppression` holds addresses never to email again (reasons `bounce`,
`complaint`). Email addresses are added from our Stalwart mail server's webhook
(`apps/webhooks/src/inbound/stalwart.routes.ts`, on when `STALWART_WEBHOOK_SECRET` is
set): when a remote server refuses a recipient for good, Stalwart posts
`delivery.dsn-perm-fail`, and a hard bounce (the address or its domain doesn't exist,
the mailbox is disabled) becomes an `email.feedback_received.v1` event, which this
service turns into a suppression. Other permanent failures (a spam policy, a message
too large) and temporary ones are recorded in `webhooks.inbound_event` and not acted on,
since the recipient's mailbox may be fine. Stalwart's WebHook object: URL
`<site>/webhooks/stalwart`, events `delivery.dsn-perm-fail` and `delivery.dsn-temp-fail`
(policy "include"), `signatureKey` the same value as `STALWART_WEBHOOK_SECRET`. Spam
complaints need a feedback loop parser: Stalwart's report events don't name the
recipient.

Locally, `bun run db:up:mail` runs Stalwart in docker compose with that webhook pointed
at the webhooks service on the host, and mail to `anything@bounce.test` bounces
permanently (see `docker-compose.yml`).

The delivery log is purged after `NOTIFICATION_HISTORY_DAYS` by the worker's
`outbox-retention` task.

## Adding a notification

1. Add its payload to `notificationPayload` in `packages/jobs/src/queues.ts` (`template`,
   `to`, `data`).
2. Add its copy to `packages/i18n/messages/en.json` and an email component to
   `packages/email`.
3. Add an entry to `templates` in `apps/notifications/src/dispatch/templates.ts`. The
   registry's `satisfies` makes a missing one a compile error.
4. Send it: `createProducer("notifications-critical", redis).add("send", payload,
   { jobId })` from the producing service, or `requestNotification` inside the change's
   transaction. When a domain event should notify someone, route the event to
   `events-notifications` in `eventSubscribers` and map it in
   `apps/notifications/src/events/events.processor.ts`.
