# apps/notifications

NestJS worker, port 3003 (health only). Consumes `notifications-critical` and
`events-notifications`, and sends email: sign-in codes and security alerts.

## Commands (from the repo root)

- Unit tests: `bun run --filter @repo/notifications test`
- Integration tests (Valkey, Postgres, Mailpit): `bun run db:up`, then
  `bun run --filter @repo/notifications test:integration`
- Preview email templates: `bun run --filter @repo/email dev` (port 3030)

## Where things are

- `src/dispatch/templates.ts`: every email and the steps to add one.
- `src/dispatch/dispatcher.ts`: renders in the recipient's locale and claims each send
  in `delivery-log.ts`, so a redelivered job sends nothing twice.
- `src/dispatch/policy.ts`: the suppression list (hard bounces, complaints).
- `src/channels/email/`: the transport interface and its SMTP provider.
- `src/events/events.processor.ts`: notifications requested through the outbox, and
  the mail server's feedback that feeds the suppression list.

## Gotchas

- Locally, email goes to Mailpit (http://localhost:58025). Production refuses a
  plain-text SMTP URL.
- Copy comes from the injected translator (`@InjectI18n()`, `I18nModule` in
  `src/app.module.ts`), so a new `MessageSource` is wired in one place.
