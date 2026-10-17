---
paths:
  - "apps/notifications/**"
  - "packages/email/**"
---

# apps/notifications

- Every notification is an email template in `src/dispatch/templates.ts`. Adding one, in the same change: the payload schema in
  `packages/jobs`, the copy in every `packages/i18n` catalog, the email component in
  `packages/email`, then the registry entry.
- The provider sits behind `EmailTransport` (`channels/email`), chosen from env in its
  module, and templates behind `TemplateSource`. Call the interface; never import
  nodemailer outside its transport.
- A new provider is a new transport class plus a branch in the module factory and its
  env in `src/env.ts`. Production must refuse test-only settings; keep the boot guards
  in `src/env.ts` for that.
- All user-facing text comes from `@repo/i18n` with the recipient's locale and time
  zone. No literal strings in templates or subjects.
- Processors validate every job with `parseJob(queue, name, job.data)` and restore the
  request context with `runWithContext`. Producers must set `jobId`.
- Sends are exactly-once per `jobId`, channel and recipient through
  `DeliveryLog.claim()`. Keep every send path behind it; retries must never double-send.
- Never send to a suppressed address (`dispatch/policy.ts`: hard bounces, complaints).
- Tests: pure logic as `src/**/*.test.ts`. Delivery goes in
  `test/*.integration.test.ts` against real Valkey, Postgres (as `app_notifications`) and
  Mailpit. Do not mock transports.
