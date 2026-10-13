---
paths:
  - "apps/api/src/**"
  - "apps/api/test/**"
---

# apps/api modules

- A feature is `src/modules/<name>/` with `<name>.module.ts`, `.service.ts`,
  `.repository.ts`, `.router.ts` and an `index.ts` barrel. `modules/todo` is the
  reference; copy its shape. Register the module in `app.module.ts` and its router in
  `src/rpc/router.ts` (`os.router` makes a missing or extra procedure a compile error).
- Other modules import a module only through its `index.ts` (dependency-cruiser
  `api-modules-only-via-barrel`).
- Routers are thin: pick the procedure builder, call the service, nothing else.
- Pick the narrowest builder from `src/rpc/procedures.ts`: `base` (public), `authed`,
  `fresh` (recent sign-in, for account changes), `inOrg` (tenant data), `orgAdmin`
  (owner/admin). Never re-implement session or membership checks in a service. A
  procedure on `base` must be listed in `PUBLIC` in `src/rpc/router.test.ts` with the
  reason anyone may call it; the test fails for any other one a signed-out call reaches.
- Repositories are the only code that touches Prisma, including raw SQL and tables
  owned by another module (a module reads the organization or its members through its
  own repository). Reads use `withTenant(this.database.read, orgId)`. A multi-statement
  write stays in the service: it opens `tenantTx(this.database.write, orgId, ...)` and
  passes the `Tx` to repository methods, so the change and its event commit together.
  Per-user rows use `withUser` / `userTx`. `scripts/check-layers.ts` (in
  `lint:boundaries`) fails when any other file under `src/modules` calls a model. Never
  query tenant tables with the bare client: RLS returns
  nothing, which looks like "not found", not like a bug.
- Ids are branded (`OrgId`, `UserId`, `TodoId`, ...; `@repo/contracts/ids`): services
  and repositories take the branded type, never `string`, and the procedures hand
  routers `context.orgId`, `context.userId` and `context.user.id` already branded.
  better-auth's ids are branded once in `src/auth/ids.ts` (`userIdOf`, `orgIdOf`,
  `membershipOf`, `sessionWithIds`); a row's id is parsed where the code hands it on
  (`todoIdSchema.parse(row.id)`), or taken from the branded id it was queried by. Never
  cast a string to an id.
- Inside `tenantTx`/`userTx` only database calls. No HTTP, Redis or queue awaits: the
  transaction holds a pooled connection and times out after 5s.
- Domain events: `emitEvent(tx, "<name>.v1", payload)` from `src/outbox.ts`, in the same
  transaction as the change. Time-critical notifications (codes, invitations) go
  straight to the `notifications-critical` producer (`src/notifications.ts`).
- Errors: `throw new AppError("CODE", { params })` from `@repo/nest-common`. Codes live
  in `packages/contracts/src/errors.ts`; never throw bare `Error` for an expected case
  and never put user-facing text in errors.
- Rate limits are declared in the procedure's contract (`meta({ rateLimit })`, see
  `.claude/rules/contracts.md`) and applied by the builders, per user or per workspace.
  Anything that costs money or sends messages needs one. `createRateLimiter` from
  `@repo/nest-common` in a service is only for what the contract can't key on (the phone
  number a code is sent to) or what other ways in share (todo changes over MCP).
- Paid features check `BillingService.require(orgId, entitlement)`. Optional features
  are on only when their env is set (`src/features.ts`) and otherwise answer
  `FEATURE_DISABLED`.
- Tests: unit tests next to the code as `src/**/*.test.ts` (no services). Anything that
  touches the database, Redis, auth or email goes in `test/*.integration.test.ts` using
  `test/harness.ts` (`startApi`, `createSession`, `takeNotification`) and factories
  from `@repo/db/testing`.
