# apps/webhooks

NestJS on Fastify, port 3004. Receives provider webhooks: today the mail server's
(Stalwart's) delivery failures.

## Commands (from the repo root)

- Unit tests: `bun run --filter @repo/webhooks test`
- Integration tests: `bun run db:up`, then `bun run --filter @repo/webhooks test:integration`
- Real bounces: `bun run db:up:mail`, then the Stalwart tests
  (`STALWART_URL=http://localhost:58080`, see `test/stalwart.integration.test.ts`).

## Where things are

- `src/inbound/stalwart.routes.ts` and `stalwart-events.ts`: the mail server's delivery
  failures (HMAC `X-Signature`, `STALWART_WEBHOOK_SECRET`), which hard bounces become
  `email.feedback_received.v1` for notifications' suppression list. Stalwart reassigns
  event ids per batch, so duplicates are keyed on the event's content.
- `src/outbox.ts`: this service's own outbox (`webhooks.outbox_event`).

## Gotchas

- A new inbound provider copies the Stalwart route: raw body, verify the signature,
  insert with a unique provider event id (`skipDuplicates`), emit, reply 200.
