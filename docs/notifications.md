# Notifications

apps/notifications delivers every message a user receives: email, in-app, push and
text. Other services never send anything themselves; they queue a notification job, or
emit a domain event that the notification service maps to one.

## How a notification flows

1. A producer adds a `send` job to the template's queue (`notificationQueue` in
   `packages/jobs/src/queues.ts`): `notifications-critical` for codes, alerts,
   invitations and billing failures, `notifications-bulk` for everything else. They have
   separate worker pools, so a big batch never delays a sign-in code. A notification
   that must not be lost goes out with the change it's about instead:
   `requestNotification(tx, …)` (`apps/api/src/notifications.ts`) writes it to the
   outbox in the change's transaction, as `notification.requested.v1`, and this service
   sends it from there. Security alerts go this way: Redis being down delays one, never
   drops it, and a change that rolls back sends none.
2. The dispatcher (`apps/notifications/src/dispatch/dispatcher.ts`) resolves the
   recipients (a user, an email or phone for someone without an account, or every
   member of an organization with given roles), binds the template, and for each
   recipient and channel:
   - claims the delivery in the delivery log (`notifications.delivery`), keyed on job id,
     channel and recipient, so retries and redelivered events never double-send;
   - applies the recipient's preferences, digest, quiet hours and the suppression list;
   - sends, and records the outcome (`sent`, `skipped`, `suppressed`, `failed`).
3. If any channel fails, the job throws after trying the others, and its retry redoes
   only the failed ones.

Everything is rendered in the recipient's language and time zone from `packages/i18n`.

## Channels

| Channel | Provider | Configured by |
|---|---|---|
| `email` | SMTP submission to our Stalwart mail server (Mailpit locally), behind `EmailTransport` (`channels/email/email-transport.ts`) | `SMTP_URL`, `EMAIL_FROM` |
| `in_app` | a `notifications.notification` row, plus a realtime nudge to the user's open tabs | always on |
| `push` | FCM (Android), APNs (iOS), Web Push (browsers), behind `PushTransport` (`channels/push/push-transport.ts`) | each platform when all its variables are set |
| `sms` | Twilio, or Mailpit as emails to `<digits>@sms.test` locally, behind `SmsTransport` (`channels/sms/sms-transport.ts`) | `SMS_PROVIDER`, `TWILIO_*` |

See [environment.md](environment.md) for the variables. To add a provider, implement the
channel's transport interface and register it in that channel's module; the dispatcher
doesn't change.

Devices register through the API (`notifications.register_device`): the web app with a
Web Push subscription (service worker in `apps/web/public/sw.js`, only the browsers'
push hosts are accepted), the mobile app with its native FCM or APNs token. Tokens a
provider reports as dead are deleted.

## Categories and templates

Every template belongs to a category (`packages/contracts/src/notifications.ts`). A
category caps which channels its templates may use; transactional categories can't be
turned off.

| Category | User can turn off | Channels |
|---|---|---|
| `security` | no | email, sms |
| `invitations` | no | email |
| `billing` | no | in_app, email |
| `workspace` | yes | in_app, email, push |
| `activity` | yes | in_app, email, push |

| Template | Category | Renders to | Sent when |
|---|---|---|---|
| `auth.otp` | security | email | sign-up verification, password reset, email change |
| `auth.phone-code` | security | sms | adding a phone number |
| `auth.security-alert` | security | email, sms | a sensitive account change ([auth.md](auth.md)) |
| `org.invitation` | invitations | email | someone is invited to a workspace |
| `billing.payment-failed` | billing | in_app, email | a renewal fails (owners and admins) |
| `workspace.access-created` | security | email | an API key or webhook endpoint was created (owners and admins, from `org.api_key_created.v1` and `webhook.endpoint_created.v1`) |
| `webhooks.endpoint-disabled` | workspace | in_app, email, push | an endpoint was disabled for failing (owners and admins, from the `webhook.endpoint_disabled.v1` event) |
| `todo.reminder` | activity | in_app, email, push | the example bulk template; nothing produces it yet |

Templates are defined in code (`apps/notifications/src/dispatch/templates.ts`) and
reached only through `TemplateSource`, so they can later move to a database (editable
copy, per-tenant branding) by binding another implementation in
`notifications.module.ts`. Email bodies are React Email components in
`packages/email/src/templates`; preview them with `bun run --cwd packages/email dev`
(http://localhost:3030). In-app notifications are stored as template and data, not text,
so clients render them in the reader's current language (`notification.<type>` in
`packages/i18n`).

## What users control

Settings are per user (`notifications.preference`, `notifications.settings`, edited
through the API; the web app's notification settings page):

- **Preferences**: each mutable category on or off per channel.
- **Daily digest**: opt-out-able email (mutable categories) goes into
  `notifications.digest_item` instead, and one digest email a day summarises it. An
  hourly scheduler queues a `digest` job for each user with items once it's
  `DIGEST_HOUR` or later in their time zone; each is claimed per user and local date, so
  nobody gets two.
- **Quiet hours**: a window in the user's time zone (it may cross midnight). Push
  inside it becomes a delayed `deferred` job that runs when the window ends, still keyed
  on the original delivery. Texts don't wait: they're security messages.

## Unsubscribe and suppression

Email a user can opt out of carries an unsubscribe link and RFC 8058 one-click headers
(`List-Unsubscribe`, `List-Unsubscribe-Post`). Both hold a token signed with
`UNSUBSCRIBE_SECRET` naming the user and category:

- a person clicking the link lands on the web app's `/unsubscribe` page;
- a mail client POSTs to `/api/v1/notifications/unsubscribe?token=…`
  (`apps/api/src/modules/notifications/unsubscribe.routes.ts`), no session needed.

Either turns that category's email off for the user.

`notifications.suppression` holds addresses never to use again on a channel (reasons
`bounce`, `complaint`, `unsubscribe`, `invalid`). Email and SMS check it before sending.
Numbers that reply STOP or can't receive texts are added from Twilio's answer. Email
addresses are added from our Stalwart mail server's webhook
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

Delivery logs, and in-app notifications read more than `NOTIFICATION_HISTORY_DAYS` ago,
are purged by the worker's `outbox-retention` task.

## Adding a notification

1. Add its payload to `notificationPayload` in `packages/jobs/src/queues.ts` (`template`,
   `to`, `data`) and pick its queue in `notificationQueue`.
2. Add its copy to `packages/i18n/messages/*.json` (email subject and body, push, SMS and
   `notification.<type>` for in-app as needed), and an email component to
   `packages/email` if it emails. For in-app, add its data shape to `inAppNotifications`
   in `packages/contracts/src/notifications.ts`.
3. Add an entry to `templates` in `apps/notifications/src/dispatch/templates.ts` with its
   category and renderers. The registry's `satisfies` makes a missing one a compile error.
4. Send it: `createProducer(queue, redis).add("send", payload, { jobId })` from the
   producing service, or, when a domain event should notify someone, route the event to
   `events-notifications` in `eventSubscribers` and map it in
   `apps/notifications/src/events/events.processor.ts`.

A new category goes in `notificationCategories` with its channels, and gets copy under
`notificationPreferences.categories.<name>`.
