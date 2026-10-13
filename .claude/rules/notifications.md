---
paths:
  - "apps/notifications/**"
  - "packages/email/**"
---

# apps/notifications

- Every notification is a template in `src/dispatch/templates.ts` (typed
  `satisfies TemplateRegistry`). Adding one, in the same change: the payload schema in
  `packages/jobs`, the copy in every `packages/i18n` catalog, the email component in
  `packages/email`, then the registry entry.
- Providers sit behind one interface per channel, chosen from env in the channel's
  module: `EmailTransport` (`channels/email`), `SmsTransport` (`channels/sms`),
  `PushTransport` (`channels/push`), and `TemplateSource` for template storage. Call the
  interface; never import nodemailer, Twilio, FCM or APNs code outside its transport.
- A new provider is a new transport class plus a branch in the module factory and its
  env in `src/env.ts`. Production must refuse test-only settings; keep the boot guards
  in `src/env.ts` for that.
- All user-facing text comes from `@repo/i18n` with the recipient's locale and time
  zone. No literal strings in templates, subjects, SMS or push bodies.
- Processors validate every job with `parseJob(queue, name, job.data)` and restore the
  request context with `runWithContext`. Producers must set `jobId`.
- Sends are exactly-once per `jobId`, channel and recipient through
  `DeliveryLog.claim()`. Keep every send path behind it; retries must never double-send.
- Respect preferences (`dispatch/policy.ts`): only categories that are not `mutable` in
  `@repo/contracts/notifications` may bypass them. Email in a mutable category carries
  the RFC 8058 one-click unsubscribe headers (`listUnsubscribeHeaders` in the dispatcher).
- Tests: pure logic as `src/**/*.test.ts`. Delivery goes in
  `test/*.integration.test.ts` against real Valkey, Postgres (as `app_notifications`) and
  Mailpit, with the local HTTP fakes in `test/fake-twilio.ts` and `test/fake-push.ts`
  for providers. Do not mock transports.
