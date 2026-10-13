# apps/api

NestJS on Fastify, port 3001. Serves better-auth (`src/auth/`), the oRPC API at `/rpc`
(web and mobile), the same router as REST at `/api/v1` with `/api/v1/openapi.json`, the
MCP server (`src/mcp/`), and `/docs` outside production.

## Commands (from the repo root)

- Unit tests: `bun run --filter @repo/api test`
- Integration tests: `bun run db:up`, then `bun run --filter @repo/api test:integration`
- Regenerate `openapi.json` after a contract change: `bun run gen`
- Demo data: `bun run db:seed`

## Where things are

- `src/rpc/procedures.ts`: the procedure builders (`base`, `authed`, `fresh`, `inOrg`,
  `orgAdmin`), API-key auth and error mapping. `src/rpc/router.ts`: the router and the
  steps to add a feature. `src/rpc/openapi.ts`: the REST document.
- `src/modules/<feature>/`: one Nest module per feature; `modules/todo` is the example.
- `src/outbox.ts`: `emitEvent` for this service's events (`app.outbox_event`).
- `src/notifications.ts`: the producer for time-critical notifications.
- `src/features.ts`: which optional features are on (by env).
- `test/harness.ts`: `startApi`, `createSession` (typed RPC client with a cookie jar),
  `takeNotification`, `takeOtp`.

## Gotchas

- Integration tests start the API in-process on a cloned database and a private Redis
  database index, so they run in parallel with a dev stack.
- better-auth tables are Prisma models; `bun run --filter @repo/api auth:schema` writes
  what better-auth expects to `node_modules/.cache/auth-schema.prisma`, to compare with
  `packages/db/prisma/schema/auth.prisma` after a plugin upgrade.
- Routes outside oRPC (`files.routes.ts`, `unsubscribe.routes.ts`, `mcp.routes.ts`) are
  plain Fastify handlers and do their own auth and validation.
- The procedure pipeline has no rate limiter: each service adds `createRateLimiter`
  where it is needed.
- Import injected classes with a plain `import`, never `import type`: Nest resolves
  constructor parameters from decorator metadata, which needs the class at runtime, and
  `import type` erases it (the service then fails at boot with an unresolved dependency).
  That's why Biome's `useImportType` is off for the Nest apps (`biome.jsonc`).
