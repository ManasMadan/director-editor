# Code generation

`bun run gen` runs every package's `gen` script through turbo. Each one derives code
from a single source of truth, so a type or schema is written once and every other
language and client follows. turbo runs `gen` before `dev`, `build`, `check-types` and
the tests (`turbo.json`), so a fresh clone never sees missing types.

Run it after changing a Prisma schema, a queue or message schema, the API contract, or
the Python service's routes and models, and commit what changes.

## Generators

| Package | Source | Output | Committed |
|---|---|---|---|
| `packages/db` | `prisma/schema/*.prisma` | `src/generated/prisma` (the Prisma client, `prisma generate`) | no |
| `packages/jobs` | zod schemas in `src/queues.ts` and `packages/contracts/src/realtime.ts` | `generated/schemas/*.json` (JSON Schema), `generated/queue-settings.json`; every event's schema in `generated/events.json` (the compatibility check) | yes |
| `packages/i18n` | `messages/en.json` | `messages/en.d.json.ts` (the catalog's type, each message as its literal text, so ICU arguments are type-checked) | yes |
| `apps/ai` | its FastAPI app, and the JSON Schemas above | `openapi.json`; `app/contracts/*.py` (Pydantic models) and `app/contracts/queue_settings.json` | yes |
| `packages/ai-client` | `apps/ai/openapi.json` | `src/generated` (typed fetch client, zod schemas, SDK) | yes |
| `apps/api` | the oRPC contract in `packages/contracts/src/api` | `openapi.json` (the public REST API, `/api/v1`) | yes |
| `apps/mobile` | `global.css` | `uniwind-types.d.ts` | no |

The order comes from package dependencies (`"dependsOn": ["^gen"]`): `@repo/ai` depends
on `@repo/jobs`, and `@repo/ai-client` on `@repo/ai`, so the chain below always runs in
sequence.

### Queue payloads: zod → JSON Schema → Pydantic

A job the Python service consumes is defined once, in zod:

1. `packages/jobs/scripts/export-schemas.ts` writes each entry of its `schemas` map as
   JSON Schema, one per job (`ai_ingest_ingest_job.json` and
   `ai_ingest_summarize_job.json` are `{ meta, payload }` of the `ai-ingest` queue's two
   jobs; `realtime_message.json` is the realtime message), the job and queue names as
   Literals, the error response and codes, and the shared queues' Redis prefix and job
   options to `queue-settings.json`. It clears stale files first.
2. `apps/ai`'s `gen` turns them into Pydantic v2 models with `datamodel-codegen`
   (`app/contracts/ai_ingest_ingest_job.py`, `ai_ingest_summarize_job.py`,
   `realtime_message.py`, `error_response.py`, ...), formats them with ruff and
   copies the queue settings next to them.

Both languages then validate the same shape, and Python uses the same prefix and retry
options as TypeScript. When a Python service starts producing or consuming another
queue or message, add it to `schemas` (and to `shared`, for a queue) in
`export-schemas.ts`.

### The AI service's client: Pydantic → OpenAPI → TypeScript

`apps/ai`'s `gen` first runs `python -m app.export_openapi openapi.json`, which writes
the FastAPI app's schema without starting a server. `packages/ai-client` then runs
`openapi-ts` (hey-api, configured in `openapi-ts.config.ts`) with the fetch client, zod
and SDK plugins: every response is validated at runtime, so a Python change that breaks
the contract fails in the API instead of passing bad data on. Each route's
`operation_id` becomes the function name. `packages/ai-client/src/index.ts` is the
hand-written wrapper the API uses.

### The public REST API document

`apps/api/scripts/openapi.ts` writes `apps/api/openapi.json` from the same contract that
serves `/rpc` and `/api/v1`, with version `1` and a relative server URL (the running API
serves the same document at `/api/v1/openapi.json` with its release and public URL).

On pull requests the **API compatibility** job (`api-compat` in `ci.yml`) compares it
with the base branch's copy using oasdiff and fails on breaking changes (removed
operations or fields, new required inputs). A title that declares the break
(`feat(api)!: …`) turns the failure into a report, and the release notes list it first, for
a new major version.

### Prisma client

Generated into `packages/db/src/generated/prisma` (Rust-free, ESM) and not committed:
it's large and deterministic from the schema. The Docker builds run
`bun run --cwd packages/db gen` themselves (`deploy/docker/node-service.Dockerfile`).

### Uniwind types

`uniwind generate-artifacts` writes `apps/mobile/uniwind-types.d.ts` from `global.css`.
Uniwind's Metro plugin rewrites it on every start, so it's ignored by git.

## Generated files are never edited by hand

Change the source and regenerate. The Claude hooks (`.claude/hooks/guard-files.ts`)
refuse edits to anything under a `generated/` directory, `*.gen.ts` and `openapi.json`
(not `apps/ai/app/contracts`), and CI's **Generated code is committed** job (`codegen`)
runs `bun run gen` on a clean checkout and fails if any tracked file changes, which
catches all of them.
`app/contracts/*` is excluded from the Python coverage, and `generated/` and `*.gen.ts`
from lint boundaries and TypeScript coverage.
