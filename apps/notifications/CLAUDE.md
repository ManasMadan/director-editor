# apps/notifications

NestJS worker, port 3003 (health only). Consumes `notifications-critical`,
`notifications-bulk` and `events-notifications`, and delivers every channel: email,
SMS, push (iOS, Android, web) and in-app.

## Commands (from the repo root)

- Unit tests: `bun run --filter @repo/notifications test`
- Integration tests (Valkey, Postgres, Mailpit): `bun run db:up`, then
  `bun run --filter @repo/notifications test:integration`
- Preview email templates: `bun run --filter @repo/email dev` (port 3030)

## Where things are

- `src/dispatch/templates.ts`: every notification and the steps to add one.
- `src/dispatch/dispatcher.ts`: renders per channel and locale, claims each send in
  `delivery-log.ts`, adds unsubscribe headers.
- `src/dispatch/policy.ts`: preferences, quiet hours, suppression.
- `src/channels/<channel>/`: the transport interface and its providers, chosen by env
  in the channel's module.
- `src/digest/`: the daily digest, scheduled hourly and sent at `DIGEST_HOUR` local time.

## Gotchas

- Locally, email goes to Mailpit (http://localhost:58025) and SMS goes there too, as
  mail to `<digits>@sms.test` (`SMS_PROVIDER=email`). Production refuses that.
- A push platform is on only when all of its env variables are set; a partial set fails
  at boot.
- Integration tests use local HTTP fakes for Twilio and push (`test/fake-*.ts`) through
  the provider URL overrides in `src/env.ts`. Production refuses those overrides.
- Copy comes from the injected translator (`@InjectI18n()`, `I18nModule` in
  `src/app.module.ts`), so a new `MessageSource` is wired in one place.
