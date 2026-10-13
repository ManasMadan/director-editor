# When something's off

Start with `bun run doctor`. It checks the tools, `.env` against `.env.example` and the
local services, and prints the fix next to each problem. `bun dev` runs it first and
won't start while it reports one.

## What the doctor says

| It says | Do this |
|---|---|
| Node … found, 24 expected | `nvm use` (reads `.nvmrc`); `nvm install` first if you don't have it |
| Bun … found, … needed | `bun upgrade`. A warning that CI uses another version means your Bun works but differs from the pinned one (`packageManager` in `package.json`) |
| uv is not installed | `brew install uv` (or https://docs.astral.sh/uv/). It's needed even if you never touch Python: code generation runs the AI service's exporter, and setup, `bun dev`, types and tests all depend on it |
| Docker is not running | start Docker Desktop, or your Docker daemon |
| No .env yet | `bun run setup` |
| Missing in .env: … | `bun run setup`. It happens after pulling a change that added variables; setup adds them and generates the secrets, and keeps your values |
| Still set to a placeholder | `bun run setup` replaces placeholders with fresh values |
| In .env but not in .env.example | a variable was renamed or removed. Nothing reads it any more: delete the line from `.env` |
| postgres (valkey, mailpit) is not running | `bun run db:up` |
| Database roles are missing | your Postgres volume is older than the role setup in `infra/postgres/init`, which only runs on an empty volume. `docker compose down -v && bun run setup` recreates it, and deletes your local data |

## Local services

**A port is taken.** Every host port is a variable in `.env.example` (`POSTGRES_PORT`,
`S3_CONSOLE_PORT`, …). Find who holds it with `lsof -nP -iTCP:<port> -sTCP:LISTEN`
(without `-sTCP:LISTEN`, `lsof` also lists processes that are only connected to it).
Either stop that process, or move ours: `bun run env:set POSTGRES_PORT=55433`, update the
URLs in `.env` that use the port, and `bun run db:up`. The apps' ports are variables too
(`WEB_PORT`, `API_PORT`, …). When the holder is another checkout's `bun dev` or e2e run,
give this checkout its own stack instead: `bun run setup --stack <n>` moves every port
and URL at once ([environment.md](environment.md#local-service-ports)).

**"Not starting …: they may use up to … GB".** `bun run db:up` adds up the memory limits
of what it's about to start and refuses when Docker hasn't that much free, because a
Docker that runs out of memory kills containers, and not necessarily ours. What each
profile needs free, limits plus half a gigabyte of headroom:

| Command | Starts | Needs free |
|---|---|---|
| `bun run db:up` (`bun dev`) | Postgres, Valkey, Mailpit | about 1.4 GB |
| `bun run db:up:mail` | plus Stalwart | about 1.7 GB |
| `bun run db:up:full` (`bun dev:full`, `test:integration`, `test:coverage`) | plus RustFS, ClamAV, Jaeger | about 3.9 GB |

Docker Desktop's default is 2 GB, enough for the core only: raise it in Settings,
Resources, or stop other containers. `bun scripts/services.ts check --full` says whether
the full profile would fit without starting anything.

**Uploads stay pending on a first `dev:full`.** ClamAV downloads its virus signatures on
its first start, which can take several minutes; it starts in the background so the rest
doesn't wait, and the worker scans uploads once it answers.
`docker compose logs -f clamav` shows the download.

**Uploads stay pending after the stack has run for hours.** The local ClamAV can stop
answering; the worker logs `clamd timed out`. `docker compose restart clamav`.

**A service's own logs**: `docker compose logs <postgres|valkey|mailpit|rustfs|clamav|stalwart> --tail 100`.

## Running the apps

**A service exits at boot with a variable's name.** Its `src/env.ts` (or
`apps/ai/app/settings.py`) validated the environment and says which variable is wrong.
Set it with `bun run env:set KEY=value`.

**Types or imports are missing after a pull.** Run `bun run gen` (the Prisma client and
the API and AI clients are generated, not committed). Tables missing:
`bun run db:deploy`.

**An email, text or code never arrives.** Locally nothing leaves the machine: it's in
Mailpit, http://localhost:58025, texts included. If it isn't there, the notifications
service isn't running, or the job failed: `bun run jobs` shows every queue's counts and
`bun run jobs failed <queue>` the failures, with their error.

**A list is empty for data that exists.** Row-level security hides rows from a query
that doesn't run in the organization's context, or runs in another one. That's a bug
in the query, not missing data ([database.md](database.md)).

**`FEATURE_DISABLED`.** The feature's variables aren't set: uploads need `S3_BUCKET`,
billing the Stripe variables, the assistant the AI service
([environment.md](environment.md)).

## Tests

**`bun run test:e2e` refuses to start** because something already listens on the
stack's ports: it builds and starts its own stack, so an old server can't answer in its
place. Stop `bun dev` first, or run the web suite against the stack you have running:
`bun run --cwd apps/web test:e2e`.

**Integration tests fail with `fetch failed` in the upload tests**, or refuse to start:
they need the full profile, so Docker needs about 3.9 GB free (above).

**Something passes locally and fails in CI.** CI runs with `.env.example`'s values, never
your `.env`, and so do the tests locally; a test that depends on a value only your
`.env` has is the usual cause. `gh run view <id> --log-failed` shows the failing step.

## Still stuck

The debug runbook (`.claude/skills/debug/SKILL.md`) follows one request through the
logs by its `x-request-id`, locally and in a cluster.
