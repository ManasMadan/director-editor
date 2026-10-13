# apps/webhooks

NestJS on Fastify, port 3004. Receives provider webhooks (Stripe, and Stalwart's bounces) and delivers
customers' outbound webhooks.

Outbound delivery is built here rather than on Svix (which does the same, self-hosted):
it's a few processors over tables and queues the stack already runs, where Svix would be
another stateful service with its own database to deploy, back up and upgrade. Signing
follows Standard Webhooks through its reference library, so receivers can use Svix's
libraries anyway, and a move to Svix later keeps the same headers.

## Commands (from the repo root)

- Unit tests: `bun run --filter @repo/webhooks test`
- Integration tests: `bun run db:up`, then `bun run --filter @repo/webhooks test:integration`
- Real bounces: `bun run db:up:mail`, then the Stalwart tests
  (`STALWART_URL=http://localhost:58080`, see `test/stalwart.integration.test.ts`).
- Real Stripe test events: `stripe listen --forward-to localhost:3004/webhooks/stripe`,
  then `bun run env:set STRIPE_WEBHOOK_SECRET=whsec_...`. Without an account:
  `bun run stripe:fake`.

## Where things are

- `src/inbound/stripe.routes.ts`: raw-body route, signature check, store and emit
  `stripe.event_received.v1`. No processing happens here.
- `src/inbound/stalwart.routes.ts` and `stalwart-events.ts`: the mail server's delivery
  failures (HMAC `X-Signature`, `STALWART_WEBHOOK_SECRET`), which hard bounces become
  `email.feedback_received.v1` for notifications' suppression list. Stalwart reassigns
  event ids per batch, so duplicates are keyed on the event's content.
- `src/outbound/fanout.processor.ts`: event to one delivery row per subscribed endpoint.
- `src/outbound/delivery.processor.ts` and `delivery.service.ts`: send with retries on
  `WEBHOOK_RETRY_DELAYS_MS`, auto-disable after `WEBHOOK_AUTO_DISABLE_HOURS`.
- `src/outbound/signing.ts`: Standard Webhooks signatures (`webhook-id`,
  `webhook-timestamp`, `webhook-signature`).
- `src/outbox.ts`: this service's own outbox (`webhooks.outbox_event`).

## Gotchas

- Outbound requests only go through `safeFetch`. Local receivers on 127.0.0.1 work
  because `.env.example` sets `WEBHOOK_ALLOWED_PRIVATE_ADDRESSES`; production refuses a
  non-empty value.
- Endpoint secrets are stored encrypted (`SecretBox`, `ENCRYPTION_KEYS`); the api
  encrypts, this service decrypts, so both need the same key list. The first key is the
  active one; keep older ids in the list while anything is still encrypted with them.
- A new inbound provider copies the Stripe route: raw body, verify, insert with a unique
  provider event id (`skipDuplicates`), emit, reply 200.
