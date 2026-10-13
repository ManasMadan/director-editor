# Python services

`apps/ai` is one Python 3.14 codebase that runs as two processes: a FastAPI app (port
8000) and a BullMQ worker. It owns the `ai` schema (documents, their chunks and
embeddings, token usage) and everything that calls a model. turbo drives it like the
TypeScript packages through a thin `package.json`; the Python tooling is uv.

## Who calls it

Only apps/api, through the generated client in `packages/ai-client` (see
[codegen.md](codegen.md)). The API has already authenticated the user, checked their
membership, and applied rate limits and input limits; every call carries a JWT it signed
for that call (HS256 with `AI_SERVICE_SECRET`, issuer `api`, audience `ai`, 60 seconds)
naming the user and organization (`app/auth.py`). The service trusts nothing else, and
every query is scoped to that organization by row-level security
(`tenant(org_id)` in `app/db/session.py`).

The one route reachable from outside is the MCP server at `/ai/mcp`, which checks OAuth
tokens itself (below). It's a second MCP server next to the api's (`/api/mcp`, todos) on
purpose: the document tools need retrieval and the model, which live here, so serving
them from the api would put a hop and a second copy of their inputs in between. Both
trust the same OAuth server (the api's JWKS), so one connected app can use both; a
client connects to each URL it's given.

| Route | What it does |
|---|---|
| `GET /health/live`, `GET /health/ready` | probes (ready: the process serves requests) |
| `GET /health/dependencies` | Postgres and Redis answer (dashboards, start-up scripts) |
| `POST /v1/sentiment` | the example model in `app/model.py`, a word-list classifier |
| `GET/POST /v1/documents`, `DELETE /v1/documents/{document_id}` | a workspace's documents; creating one queues indexing |
| `POST /v1/assistant/answers` | the assistant's answer, as server-sent events |
| `/ai/mcp` | the MCP server, when `BETTER_AUTH_URL` and `API_URL` are set |

Errors have the API's own wire shape (`app/errors.py`), oRPC's error JSON as
`errorResponse` in `packages/contracts/src/api/base.ts` defines it:
`{defined, code, status, message, data: {params, requestId, issues}}`. The model, the
`ErrorCode` Literal and each code's status are generated from `packages/contracts`
(`app/contracts/error_response.py`, `error_codes.json`), so raise `AppError("CODE",
params)`: a code outside the catalog doesn't type-check, and the status always comes
from the catalog. A status the framework answers with that has no code of its own (405,
say) becomes `BAD_REQUEST` 400, or `INTERNAL` 500 for a 5xx. Every route declares the
model (`responses` in `app/main.py`), so `packages/ai-client` parses errors against it
instead of guessing. The API passes `DOCUMENT_NOT_FOUND`, `AI_BUDGET_EXCEEDED`,
`FEATURE_DISABLED` and `VALIDATION_FAILED` on to clients; anything else becomes
`UPSTREAM_UNAVAILABLE`.

## Documents and retrieval

Creating a document stores its text and queues an `ingest` job (`app/documents.py`).
The worker splits it into passages (`app/chunking.py`: paragraphs up to 1200
characters, split on sentence ends, 150 characters of overlap), embeds them in batches
and stores them in `ai.chunk`, a pgvector column with an HNSW cosine index. Search is
nearest-neighbour within the caller's organization.

Embeddings go through the `Embedder` interface (`app/embeddings.py`):
`ProviderEmbedder` for any Pydantic AI embedding model (`AI_EMBEDDINGS`), asked for 1536
dimensions, or `HashingEmbedder`, which hashes words into the same space with no model
(lexical, development and tests only). Passages below the relevance floor
(`AI_MIN_RELEVANCE`, cosine similarity) aren't returned, so a question the documents
can't answer finds nothing. Changing the dimension means a migration and re-indexing
every document.

## The assistant

`app/assistant.py`: a Pydantic AI agent with one tool, `search_documents`. It streams
`AssistantEvent`s: text as it's written, the documents it used, then the tokens it cost.
Retrieved text is treated as data (the instructions say so, and clients render answers
as plain text).

- **Models**: `AI_MODEL`, with `AI_FALLBACK_MODEL` when it fails. An LLM gateway is just
  another model name. Unset `AI_MODEL` turns the assistant off (`FEATURE_DISABLED`).
- **Budgets** (`app/usage.py`): before streaming starts, each answer reserves up to
  `AI_TOKENS_PER_RUN` from what's left of the workspace's monthly allowance
  (`AI_MONTHLY_TOKENS_PER_ORG`), under a per-workspace lock so concurrent answers can't
  all fit into the same remainder; nothing left is a normal `AI_BUDGET_EXCEEDED`
  response. The answer is capped at what it reserved, and records what it actually used
  however it ends: answered, stopped at the limit (`AI_RUN_LIMIT`), failed, or abandoned
  by the client. The run happens in its own task, so a client that goes away stops it
  between events and the accounting still finishes. `ai.usage` is append-only for this
  service, so a reservation is one row and settling it adds the difference; the month's
  sum is what counts, and a run that never settles (the process died) keeps its
  reservation.

## Summaries

`app/summaries.py` is a LangGraph workflow: `summarize_passages` then `combine`, each
step a Pydantic AI agent, so budgets and providers work as for the assistant. When a
model is configured, indexing queues a `summarize` job that runs it and stores the
summary on the document. It reserves and settles its tokens like an answer; a workspace
with nothing left gets no summary, and a document that needs more than one run may spend
ends without one instead of failing the job, which would only spend it again on retry. It's the pattern for multi-step AI work: add a node (a quality
check, a translation) without rewriting the rest.

## Local stand-ins

Nothing needs a model or key in development:

- `AI_MODEL=local:extractive` answers by quoting the best passage, and summaries are the
  opening sentences of the text;
- `AI_EMBEDDINGS=hashing` embeds without a model.

`.env.example` sets both. `settings.py` refuses them when `NODE_ENV=production`. For a
real model, set `AI_MODEL`, `AI_EMBEDDINGS` and the provider's key (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`) with `bun run env:set`.

## The worker

`app/worker.py` consumes `ai-ingest` (`ingest` and `summarize` jobs), validating each
against its own generated model (`app/contracts/ai_ingest_<job>_job.py`) and binding the
request id it was queued with to its logs. The models ignore fields they don't know, so
a newer producer can add an optional field without an older worker rejecting the job,
and the job names are a generated `Literal`: a job added in `packages/jobs` is a type
error in the worker until it's handled. A failure throws, and BullMQ retries with the same backoff the TypeScript
side uses (the queue settings are generated from `packages/jobs`). It publishes a live
nudge to the organization when a document changes, so the web app refreshes
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

## The MCP server

`app/mcp_server.py` serves the approved workspace's documents to MCP clients: tools
`list_documents` and `search_documents`, both needing the `documents:read` scope. Every
request needs an OAuth access token from the API's authorization server for this
resource (RFC 8707 audience `<site>/ai/mcp`), signed with a key from the API's JWKS
(fetched from `API_URL`), naming a workspace, whose grant is still active
(`auth.mcp_grant_active`). Calls are limited to 60 a minute per app and user. A tool
that fails is logged with its request id (the `x-request-id` header, or a fresh one) and
answers `INTERNAL` with that id; what went wrong never reaches the client. See
[auth.md](auth.md) for the OAuth side.

To add a tool: give it a scope in `packages/contracts/src/mcp.ts` (and the API's resource
policy in `apps/api/src/auth/auth-plugins.ts`), register it in `create_mcp_server` behind that
scope, and cover it in `tests/test_mcp.py`.

### Why there are two MCP servers

The API has its own MCP server (`apps/api/src/mcp`, at `/api/mcp`) for the TypeScript
features, and this one serves the documents. We keep them apart on purpose: each
language owns the tools over its own data. The document tools are this service's
retrieval (embeddings, pgvector, the relevance floor) running under the same row-level
security as its routes; served from the API they'd be a second HTTP hop through
`packages/ai-client` for every call, and the API would grow tool schemas for data it
doesn't own. Each server is its own OAuth resource with its own audience, so a token
for one can't be replayed against the other, and each can be deployed, scaled and rate
limited with its service.

The cost is that an MCP client connects twice (two resources, two gateway routes), and
the token checks exist in both languages. Both verify tokens the same way against the
API's JWKS and `auth.mcp_grant_active`, and `tests/test_mcp.py` and the API's OAuth
integration test cover each side. If one connection becomes the requirement, move the
document tools into the API's server behind `@repo/ai-client` and delete this one.

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
| `bun run --cwd apps/ai coverage` | every test, failing below 100% of lines and branches of `app/` and `evals/` (`pyproject.toml`; nothing is excluded) |
| `bun run --cwd apps/ai evals` | the evals (below) |
| `bun run --cwd apps/ai check-types` | basedpyright, strict, with `Any` refused (tests included) |
| `bun run --cwd apps/ai lint` | ruff check and format check, and deptry (unused, missing or transitive-only dependencies) |

## Evals

`apps/ai/evals` runs the assistant and the summarizer against a fixed handbook
(`evals/corpus.py`) with pydantic-evals, using `AI_MODEL`, `AI_EMBEDDINGS` and
`AI_MIN_RELEVANCE` from the environment:

```sh
bun run --cwd apps/ai evals
AI_MODEL=anthropic:claude-sonnet-5 AI_EMBEDDINGS=openai:text-embedding-3-small \
  EVAL_JUDGE_MODEL=anthropic:claude-sonnet-5 bun run --cwd apps/ai evals
```

With the local stand-ins (every CI run) they check the pipeline around the model:
retrieval, the relevance floor, tools, refusals, prompt-injection resistance and
summaries. With real providers the same cases measure the model; `EVAL_JUDGE_MODEL` adds
LLM-judged rubrics. The run fails below `EVAL_MIN_PASS_RATE` (default 1.0). Use them to
calibrate `AI_MIN_RELEVANCE` for a new embedding model. Nightly CI runs them against the
model in the `EVAL_MODEL` repository variable (see
[repository-settings.md](repository-settings.md)).

To add a case: put the facts it needs in `evals/corpus.py` and the question in
`evals/__main__.py`, with the checks from `evals/evaluators.py` that define a good answer.

## Adding an endpoint

1. Define request and response models (`app/schemas.py`, or the feature's module) and the
   route in `app/main.py`, with an `operation_id` (it becomes the TypeScript function
   name) and `CallerDep` for the caller. Blocking work (inference) uses a plain `def` so
   FastAPI runs it in a thread; I/O uses `async def`.
2. Query through `tenant(caller.org_id)`.
3. `bun run gen`: regenerates `apps/ai/openapi.json` and `packages/ai-client/src/generated`.
4. Add a method for it to `createAiClient` in `packages/ai-client/src/index.ts`, call it
   from `apps/api/src/modules/ai/ai.service.ts`, and expose it through a procedure in
   `packages/contracts/src/api/ai.ts` and a hook in `packages/client/src/api/ai/`.
5. Tests in `apps/ai/tests` (mark ones that need Postgres or Redis with
   `@pytest.mark.integration`).

A new module is a file under `app/`. Anything that must never block a request goes to
the worker as a job on `ai-ingest`, or on a new queue (see
[jobs-and-events.md](jobs-and-events.md)).
