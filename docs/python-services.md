# Python services

`apps/ai` is one Python 3.14 codebase that runs as two processes: a FastAPI app (port
8000) and a BullMQ worker. It owns the `ai` schema (Director's plans and takes, token
usage) and everything that calls a model: Gemini watching shorts and takes for
Director ([director.md](director.md)). turbo drives it like the
TypeScript packages through a thin `package.json`; the Python tooling is uv.

## Who calls it

Only apps/api, through the generated client in `packages/ai-client` (see
[codegen.md](codegen.md)). The API has already authenticated the user, checked their
membership, and applied rate limits and input limits; every call carries a JWT it signed
for that call (HS256 with `AI_SERVICE_SECRET`, issuer `api`, audience `ai`, 60 seconds)
naming the user and organization (`app/auth.py`). The service trusts nothing else, and
every query is scoped to that organization by row-level security
(`tenant(org_id)` in `app/db/session.py`).

| Route | What it does |
|---|---|
| `GET /health/live`, `GET /health/ready` | probes (ready: the process serves requests) |
| `GET /health/dependencies` | Postgres and Redis answer (dashboards, start-up scripts) |
| `POST /v1/director/plans`, `GET /v1/director/plans/{video_id}` | ask for a short's shot plan (queued), and read it |
| `POST /v1/director/locate` | find a thing in one camera frame, for a mark on the screen |
| `POST /v1/director/takes`, `GET /v1/director/plans/{video_id}/takes` | record a take (its review is queued), and list them |

Errors have the API's own wire shape (`app/errors.py`), oRPC's error JSON as
`errorResponse` in `packages/contracts/src/api/base.ts` defines it:
`{defined, code, status, message, data: {params, requestId, issues}}`. The model, the
`ErrorCode` Literal and each code's status are generated from `packages/contracts`
(`app/contracts/error_response.py`, `error_codes.json`), so raise `AppError("CODE",
params)`: a code outside the catalog doesn't type-check, and the status always comes
from the catalog. A status the framework answers with that has no code of its own (405,
say) becomes `BAD_REQUEST` 400, or `INTERNAL` 500 for a 5xx. Every route declares the
model (`responses` in `app/main.py`), so `packages/ai-client` parses errors against it
instead of guessing. The API passes `AI_BUDGET_EXCEEDED`, `FEATURE_DISABLED`,
`VALIDATION_FAILED` and Director's own codes on to clients (`PASSED_ON` in
`apps/api/src/modules/ai/ai.service.ts`); anything else becomes `UPSTREAM_UNAVAILABLE`.

## Budgets

Every model call reserves tokens before it runs and settles what it used however it
ends (`app/usage.py`): a workspace has `AI_MONTHLY_TOKENS_PER_ORG` a month, and each
call is capped at its feature's share (`DIRECTOR_TOKENS_PER_PLAN`, `_PER_LOCATE`,
`_PER_REVIEW`). The reservation is taken under a per-workspace lock, so concurrent calls
can't all fit into the same remainder; nothing left is a normal `AI_BUDGET_EXCEEDED`
response. `ai.usage` is append-only for this service, so a reservation is one row and
settling it adds the difference; the month's sum is what counts, and a call that never
settles (the process died) keeps its reservation.

## The worker

`app/worker.py` consumes `ai-director` (`plan`, `review-take` and `session-pass` jobs) once
`DIRECTOR_MODEL` is set, validating each against its own generated model
(`app/contracts/ai_director_<job>_job.py`) and binding the request id it was queued with
to its logs. The models ignore fields they don't know, so
a newer producer can add an optional field without an older worker rejecting the job,
and the job names are a generated `Literal`: a job added in `packages/jobs` is a type
error in the worker until it's handled. A failure throws, and BullMQ retries with the same backoff the TypeScript
side uses (the queue settings are generated from `packages/jobs`). A plan job's indexing
(`app/indexing.py`) runs in the worker, or, with `INDEXER_URL` set, on the private Cloud
Run indexer (`app/indexer.py`, the same image; [deploy.md](deploy.md#the-cloud-run-indexer)),
which the worker calls with an ID token from the metadata server (`app/google_auth.py`).
It publishes a live
nudge to the organization when a plan or a take changes, so the web app refreshes
(`app/realtime.py`: the message models and the channel's Redis name are generated from
`packages/contracts/src/realtime.ts`, so both sides agree on them).

BullMQ's Python package is pinned (`pyproject.toml`) and upgraded together with the Node
one: both change the same queues in Redis with the same Lua scripts, and
`tests/test_bullmq_pair.py` fails when the scripts the two bundle differ. Delayed jobs
can start up to a second late on the Python side, whose blocking connection doesn't
read the Redis version.

In Kubernetes it's the `ai-worker` deployment (same image, `python -m app.worker`,
scaled by KEDA on the queue). It has no port to probe, so it touches a file every ten
seconds while its event loop runs, and its liveness probe (`python -m app.heartbeat`)
fails once that's a minute old: a stuck worker is restarted. Locally `bun dev:full` starts both (apps/ai's `dev` runs
FastAPI and the worker, which restarts when a Python file changes). To run the worker on
its own, without reloading:

```sh
bun run --cwd apps/ai worker
```

## Database models

Prisma owns the DDL (`packages/db/prisma/schema/ai.prisma`). `app/db/models.py` describes
the same tables in SQLAlchemy, and `tests/test_models_match_db.py` fails when they drift
from the migrated database. They're hand-written because generating them (sqlacodegen)
follows the foreign keys into `auth` and drags those tables in too. The service connects as `app_ai`.

## Commands

| Command | What it does |
|---|---|
| `bun run --cwd apps/ai dev` | FastAPI with reload on :8000 and the queue worker, restarted on changes (part of `bun dev:full`) |
| `bun run --cwd apps/ai worker` | the queue worker alone |
| `bun run --cwd apps/ai test` | pytest without the integration tests (part of `bun run test`) |
| `bun run --cwd apps/ai test:integration` | the tests that need Postgres and Redis (part of `bun run test:integration`) |
| `bun run --cwd apps/ai coverage` | every test, failing below 100% of lines and branches of `app/`, `scripts/` and `evals/` (`pyproject.toml`; nothing is excluded) |
| `bun run --cwd apps/ai seeds:build` | re-indexes the 6 seed Shorts on Vertex AI into `packages/contracts/src/director-seeds.json` (after a plan schema change; commit the file) |
| `bun run --cwd apps/ai evals:index` | indexes the 12 Shorts of `evals/shorts.json` (the 6 seeds and 6 hard cases) on Vertex AI and prints, per Short, its shots, whether it has a script and a pose, what repair changed, the model and the time; exits non-zero unless every Short's every shot has a scene, framing, phone angle and a step |
| `bun run --cwd apps/ai check-types` | basedpyright, strict, with `Any` refused (tests included) |
| `bun run --cwd apps/ai lint` | ruff check and format check, and deptry (unused, missing or transitive-only dependencies) |

## Adding an endpoint

1. Define request and response models (`app/schemas.py`, or the feature's module) and the
   route in `app/main.py`, with an `operation_id` (it becomes the TypeScript function
   name) and `CallerDep` for the caller. Blocking work (inference) uses a plain `def` so
   FastAPI runs it in a thread; I/O uses `async def`.
2. Query through `tenant(caller.org_id)`.
3. `bun run gen`: regenerates `apps/ai/openapi.json` and `packages/ai-client/src/generated`.
4. Add a method for it to `createAiClient` in `packages/ai-client/src/index.ts`, call it
   through `callAi` (`apps/api/src/modules/ai`) from the API module that owns the
   feature (as `apps/api/src/modules/director` does), and expose it through a procedure
   in `packages/contracts/src/api/` and a hook in `packages/client/src/api/`.
5. Tests in `apps/ai/tests` (mark ones that need Postgres or Redis with
   `@pytest.mark.integration`).

A new module is a file under `app/`. Anything that must never block a request goes to
the worker as a job on `ai-director`, or on a new queue (see
[jobs-and-events.md](jobs-and-events.md)).
