---
paths:
  - "packages/contracts/**"
  - "apps/api/openapi.json"
---

# packages/contracts

The contract is the public API: web, mobile, the REST API at `/api/v1` and old mobile
builds in the field all depend on it.

- New procedures copy `src/api/todo.ts`: limits as `SCREAMING_CASE` consts, an output
  schema with its inferred type, input schemas, then
  `base.meta(...).route({ method, path, tags, summary }).input(...).output(...)`.
  Register the file in `src/api/index.ts`.
- Every input has bounds: max lengths, `PAGE_SIZE_MAX`, enums instead of free strings,
  `z.int32()` for a number stored in a Postgres `integer` (a larger one fails the query).
  Lists use `pageInput` / `page(item)` from `src/pagination.ts` (cursor only).
- An id field uses its kind's branded schema from `src/ids.ts` (`orgIdSchema`,
  `userIdSchema`, `todoIdSchema`, ...), in inputs, outputs, events and job payloads, so
  the server gets a typed `TodoId` from the input and clients get one in the response.
  The brand is type-only (the OpenAPI document still says `uuid`). A new kind of id gets
  its schema and type in `src/ids.ts`; never `z.uuid()` for an id of a kind that has one.
- API keys: a procedure callable with a key sets `base.meta({ apiKeyScope: "..." })`
  with a scope from `API_KEY_SCOPES` in `src/api/scopes.ts`. No scope means keys get
  `FORBIDDEN`. Add a scope only for data a third party should reach.
- Rate limits: every procedure that changes something (any method but GET) sets
  `meta({ rateLimit })`: a `RateLimit` (`name`, `points`, `windowSeconds`, `per: "user"`
  or `"org"`) or `{ exempt: "why" }`. Everyday changes use `EVERYDAY_WRITES` from
  `src/api/base.ts`; anything that costs money, sends messages or calls out gets its own,
  failing closed. The API applies the declared limit (`apps/api/src/rpc/procedures.ts`),
  so a service never creates its own for a procedure; `src/api/rate-limits.test.ts`
  fails on a mutation with neither.
- Error codes: add to `ERROR_CODES` in `src/errors.ts` with the HTTP status, and add
  `errors.<CODE>` to every catalog in `packages/i18n` in the same change. `params` are
  ICU arguments: strings and numbers only. A module declares only codes its code can
  throw (`apps/api/src/rpc/router.test.ts` checks). Auth failures users see a sentence
  for are `AUTH_ERROR_CODES` (and `AUTH_ERROR_ALIASES`) in the same file, translated as
  `authErrors.<CODE>`.
- Events (`src/events.ts`): names are versioned (`todo.completed.v1`). Adding an
  optional field is compatible; anything else is a new `.v2` published alongside the old
  one. The `api-compat` CI job refuses anything else (`scripts/events-compat.ts`,
  against the base branch's `packages/jobs/generated/events.json`). Consumers must be
  idempotent and order-independent. Only events in `webhookEvents` reach customers, and
  the OpenAPI document's `webhooks` section describes what they receive.
- Never break `/api/v1`. Removing a field, renaming, narrowing a type or adding a
  required input fails the `api-compat` CI job (oasdiff against the base branch's
  `apps/api/openapi.json`). Add instead: new optional fields, new procedures. A real
  breaking change needs a `!` in the PR title and ships as a major version.
- After any change run `bun run gen`, and commit the regenerated `apps/api/openapi.json`
  (the `codegen` CI job fails otherwise).
- This package depends on `@orpc/contract` and `zod` only. No server code, no Node APIs:
  web and mobile bundle it.
