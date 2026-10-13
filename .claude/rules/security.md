---
paths:
  - "apps/api/src/**"
  - "apps/worker/src/**"
  - "apps/notifications/src/**"
  - "apps/webhooks/src/**"
  - "apps/ai/app/**"
  - "packages/contracts/src/**"
  - "packages/nest-common/src/**"
  - "packages/db/prisma/**"
---

# Security

- Validate at every boundary with a schema, never by hand: HTTP input through the
  contract (zod, with lengths and ranges), queue payloads with `parseJob`, env with
  t3-env in `src/env.ts`, Python input with constrained Pydantic models. Webhook
  bodies and third-party responses are untrusted too.
- Authorization is the procedure builder (`authed`, `fresh`, `inOrg`, `orgAdmin` in
  `apps/api/src/rpc/procedures.ts`) plus the service's own check for anything finer
  (ownership, entitlements). A new procedure on tenant data is at least `inOrg`;
  anything that manages members, keys, billing or webhooks is `orgAdmin`.
- A role is parsed with `parseOrgRole` from `@repo/contracts/roles`, never cast from the
  stored string (better-auth joins several with commas, and anything can be written
  there), and checked by an allow-list (`canManageWorkspace`, or `role === "owner"`),
  never by excluding one role: a role the code doesn't know must grant nothing.
- Tenant isolation is enforced by Postgres RLS, not by `where: { orgId }`. Query tenant
  data only through `withTenant`/`tenantTx` (or `tenant(org_id)` in Python) with the
  `orgId` from the procedure context, never from the input.
- Outbound HTTP to any user-supplied URL goes through `safeFetch` from
  `@repo/nest-common` (DNS pinning, private address block, redirect re-check, size and
  time limits). `WEBHOOK_ALLOWED_PRIVATE_ADDRESSES` must stay empty in production.
- Inbound webhooks verify the provider signature on the raw body (e.g. Stripe
  `constructEventAsync` in `apps/webhooks/src/inbound/stripe.routes.ts`) before parsing.
  Compare secrets and signatures with `timingSafeEqual`.
- Secrets live in `.env` (set with `bun run env:set`), never in code, fixtures, logs or
  error params. Secrets stored in the database are encrypted with `SecretBox`
  (`ENCRYPTION_KEYS`), bound to their row: `box.encrypt(value, "<table>:<id>")`, and
  the same context to decrypt. better-auth encrypts its own columns under
  BETTER_AUTH_SECRETS; don't reach into those. Signed links use `createSignedTokens`.
- Rate-limit anything that sends messages, costs money or checks a secret: the
  procedure's `meta({ rateLimit })` in packages/contracts (fails closed by default),
  `createRateLimiter` elsewhere, better-auth's `rateLimit` for auth routes.
- SQL: Prisma queries or tagged `$queryRaw`/`$executeRaw` templates. `$queryRawUnsafe`
  only when an identifier must vary, taken from a constant list, with values still as
  `$1` parameters (`apps/worker/src/maintenance/maintenance.processor.ts`). Never
  interpolate input. In Python, bound parameters only.
- Errors never leak internals: throw an `AppError` code; unknown errors become
  `INTERNAL` with the details only in the log.
- Test-only stand-ins (loopback webhook targets, SMS to Mailpit, local AI models, fake
  provider URLs) must be refused at boot in production. Keep those guards when you add
  a new one.
- Use the `security-reviewer` agent for changes to auth, procedures, webhooks, uploads
  or anything that fetches a URL.
