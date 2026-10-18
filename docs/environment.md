# Environment variables

Every service reads the one root `.env` locally (package scripts load it with
`bun --env-file` or `node --env-file-if-exists`). Nothing else does: `bunfig.toml` turns
off Bun's habit of loading `.env` into every `bun` command, so tests and scripts never
see a developer's settings unless they ask for them by name (`bun --env-file=.env`, as
`bun run test:e2e` and `bun run jobs` do). In Kubernetes each service gets only its
own variables, from the stack chart's values and its `<release>-<service>` Secret (see
`deploy/README.md`).

## How configuration works

- **Validated at boot.** Each Nest service composes its schema in `src/env.ts` from the
  shared fragments in `packages/nest-common/src/env.ts` (`coreEnv`, `databaseEnv`,
  `redisEnv`, `storageEnv`, `requiredInProduction`). The web app validates in
  `apps/web/src/env.ts` at start and at build; the Python service in
  `apps/ai/app/settings.py` on first use. A missing or malformed value stops the process
  with a readable message. Empty strings count as unset.
- **Features switch on when their block is present.** Google sign-in, captcha, files,
  AI and Director are on exactly when their variables are set
  (`apps/api/src/features.ts`). A half-configured feature (a Google client id without
  its secret) fails at boot.
  Disabled features answer `FEATURE_DISABLED`, and clients read the same map from
  `system.info` to hide their UI.
- **Production refuses dev stand-ins.** With `NODE_ENV=production` the services refuse
  to start with `FILE_SCANNER=none` (with files on), the mock Google, or a plain-text
  `SMTP_URL`. Variables wrapped in `requiredInProduction` have a localhost default in
  development and are mandatory in production.

## Setting values

`bun run setup` copies `.env.example` to `.env`, adds variables that are missing from an
existing `.env`, and replaces every `change-me` / `replace-me` placeholder with a fresh
secret (32 random bytes). Re-running it keeps existing values.

To set one value without opening `.env`:

```sh
bun run env:set GOOGLE_API_KEY=AIza...
echo "AIza..." | bun run env:set GOOGLE_API_KEY   # value from stdin, not argv
bun run env:unset OLD_VARIABLE
```

It quotes the value as needed so the services (Node's `--env-file`) and the AI service's
dev commands (Bun's) read it the same. A value with `$` is refused: Bun expands it even
in quotes and Node never does, so no spelling works for both.

`bun run doctor` reports `.env` drift against `.env.example`.

A new variable goes in the service's `src/env.ts` (or `apps/ai/app/settings.py`),
`.env.example` (set, or commented out with its default) and this file, in the same
change. The unit tests fail otherwise (`scripts/env-docs.test.ts`, and
`apps/ai/tests/test_settings_documented.py`), and a change to a service's variables runs
the kind deploy, which fails if the charts don't provide one it requires.

In the tables, "req." means the service won't start without it; a default in the second
column applies when it's unset.

## Shared by every Node service

Read by api, worker, notifications and webhooks (`coreEnv`).

| Variable | Default | What it does |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test` or `production`. Production turns on the refusals above. |
| `LOG_LEVEL` | `info` | pino level: `fatal` … `trace`, or `silent`. |
| `TRUSTED_PROXIES` | `loopback` | Comma-separated CIDRs or `loopback`, `linklocal`, `uniquelocal`: who may set `X-Forwarded-For` and `x-request-id`. The client IP drives rate limits, lockout and audit logs. The stack chart sets `uniquelocal`. |
| `LOAD_SHEDDING` | `on` | `off` stops answering 503 under pressure. Only for many instances on one machine (the integration tests). |
| `RELEASE` | `dev` | Build id (image tag), stamped by CI. |
| `PORT` | the service's own port | Where the service listens. Unset, it's the service's variable from [Local app ports](#local-app-ports) (`API_PORT`, `WORKER_PORT`, `NOTIFICATIONS_PORT`, `WEBHOOKS_PORT`), else its default there. The stack chart sets it. |

The AI service reads `NODE_ENV`, `LOG_LEVEL` (`debug`, `info`, `warning` or `error`
there) and `RELEASE` too; its package scripts pass `--port "$AI_PORT"`, and its image
listens on 8000.

### Telemetry (every service, off by default)

| Variable | Default | What it does |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | An OTLP/HTTP collector, e.g. `http://otel-collector:4318`, or locally Jaeger at `http://localhost:54318` (in the `full` profile). Set, every service exports traces and metrics there and log lines carry `traceId`; unset, nothing starts. |
| `OTEL_SERVICE_NAME` | the service (`api`, `worker`, …, `ai`, `ai-worker`) | Overrides the name traces are reported under. |

The other standard `OTEL_*` variables work as OpenTelemetry documents them (sampling,
headers for an authenticated collector, resource attributes). Code:
`packages/nest-common/src/telemetry.ts`, `apps/ai/app/telemetry.py`.

## Database

Each service connects as its own Postgres role (see [database.md](database.md)).
`databaseEnv("API")` gives `API_DATABASE_URL` and `API_DATABASE_POOL_MAX`, and so on.

| Variable | Read by | Default / example | What it does |
|---|---|---|---|
| `MIGRATOR_DATABASE_URL` | `packages/db` (Prisma CLI, test databases), apps/ai tests | `postgresql://migrator:migrator@localhost:55432/app` | The owner role. Only migrations and test setup use it. |
| `SHADOW_DATABASE_URL` | Prisma CLI | `…/app_shadow` | Scratch database `prisma migrate dev` uses to detect drift. |
| `API_DATABASE_URL` | api (req.) | `postgresql://app_api:app_api@…/app` | |
| `WORKER_DATABASE_URL` | worker (req.) | `postgresql://app_worker:…/app` | |
| `WORKER_DATABASE_DIRECT_URL` | worker (req.) | same as above locally | A non-pooled connection for the outbox relay's `LISTEN`, which a transaction-mode pooler drops. |
| `NOTIFICATIONS_DATABASE_URL` | notifications (req.) | `postgresql://app_notifications:…/app` | |
| `WEBHOOKS_DATABASE_URL` | webhooks (req.) | `postgresql://app_webhooks:…/app` | |
| `AI_DATABASE_URL` | ai (req.) | `postgresql://app_ai:…/app` | |
| `API_DATABASE_POOL_MAX`, `WORKER_DATABASE_POOL_MAX`, `NOTIFICATIONS_DATABASE_POOL_MAX`, `WEBHOOKS_DATABASE_POOL_MAX`, `AI_DATABASE_POOL_MAX` | each service | 10 (ai: 5) | Connections per process. The sum over all replicas must fit the server's limit. |

## Redis (Valkey)

| Variable | Read by | Default / example | What it does |
|---|---|---|---|
| `REDIS_URL` | api, worker, notifications, webhooks, ai (req.) | `redis://localhost:56379` | Sessions, cache, rate limits, queues, realtime pub/sub. `redis://` or `rediss://`. |

## Local service ports

Read by `docker-compose.yml` only. Change one if the port is taken, and update the URL
that uses it.

A second checkout on the same machine (a worktree) shares these services unless it runs
`bun run setup --stack <n>` (1 to 9; 0 goes back): that writes `COMPOSE_PROJECT_NAME`
(`<name>-stack<n>`, its own containers and volumes; not in `.env.example`, which leaves
the name to `docker-compose.yml`), moves every port below and every app port in the next
table by 100 × n, points the local URLs that name them at the new ones (`WEB_URL`,
`BETTER_AUTH_URL`, `API_URL`, `AI_URL`, `GOOGLE_BASE_URL`, `YOUTUBE_API_URL`, the
database, Valkey and Mailpit URLs), and writes the
same values for its tests to `.env.stack`. Two checkouts on different stacks then run
`bun dev` (or `dev:full`) and `bun run test:e2e` at the same time. Each stack takes its
own share of Docker's memory, which `bun run db:up` checks before starting it. A Google
sign-in redirect is registered per origin, so a stack's (`http://localhost:3100/...` for
stack 1) needs registering too.

| Variable | Default | Service |
|---|---|---|
| `DOCKER_BIND_ADDRESS` | 127.0.0.1 | The address every local service listens on. `0.0.0.0` opens them to your network (for a phone, with `S3_ENDPOINT` at your LAN address); their passwords are well known, so only on a network you trust. |
| `POSTGRES_PORT` | 55432 | Postgres (pgvector) |
| `VALKEY_PORT` | 56379 | Valkey |
| `MAILPIT_SMTP_PORT`, `MAILPIT_UI_PORT` | 51025, 58025 | Mailpit |
| `S3_PORT`, `S3_CONSOLE_PORT` | 59000, 59001 | RustFS (`files` profile) |
| `CLAMAV_PORT` | 53310 | ClamAV (`files` profile) |
| `CLAMAV_DATA` | the `clamav` volume | Where ClamAV keeps its signatures: an absolute directory instead of the volume. CI points it at a directory it caches, so each run doesn't download them again. |
| `STALWART_SMTPS_PORT`, `STALWART_HTTP_PORT` | 51465, 58080 | Stalwart (`mail` profile): submission over implicit TLS, management API |
| `JAEGER_OTLP_PORT`, `JAEGER_UI_PORT` | 54318, 56686 | Jaeger (`telemetry` profile, and part of `full`): OTLP/HTTP in, traces at http://localhost:56686 |

## Local app ports

Where each app listens on this machine: `bun dev`, the e2e run and the dev tools read
them, and so does `scripts/e2e.ts`, which hands them to every service and suite it starts
(CI has no `.env`, so it gets these defaults). Deployed, nothing reads them: the stack
chart sets `PORT` and each image has its own. `scripts/ports.test.ts` fails on a local port
written anywhere else, so a new app gets its variable here.

| Variable | Default | Read by |
|---|---|---|
| `WEB_PORT` | 3000 | apps/web `dev` (`next dev --port`) and `start` (`PORT` for Next's server) |
| `API_PORT`, `WORKER_PORT`, `NOTIFICATIONS_PORT`, `WEBHOOKS_PORT` | 3001, 3002, 3003, 3004 | each Nest service's `src/env.ts` when `PORT` is unset (`withServicePort`, packages/nest-common); `API_PORT` also the k6 smoke (`load/api.ts`), `WEBHOOKS_PORT` the fake Stripe's and the local Stalwart's webhook URLs |
| `AI_PORT` | 8000 | apps/ai `dev` and `start` (`fastapi --port`) |
| `EMAIL_PREVIEW_PORT` | 3030 | packages/email `dev` |
| `STORYBOOK_PORT` | 6006 | packages/ui `storybook` |
| `GOOGLE_FAKE_PORT` | 12112 | the mock Google: Gemini and YouTube for Director, a test fixture only (`bun run google:fake`; integration and e2e suites start it themselves) |

## Auth and the API (apps/api)

| Variable | Read by | Default / example | What it does |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | api (req.) | generated | At least 32 characters. Signs sessions and encrypts what better-auth stores (OAuth tokens, 2FA secrets and backup codes, JWT signing keys). |
| `BETTER_AUTH_SECRETS` | api | unset | Rotating the one above: `2:<secret>,1:<secret>`, newest first (each at least 32 characters). The newest signs and encrypts; the rest, and `BETTER_AUTH_SECRET`, still decrypt. Then `bun run secrets:reencrypt`. See the rotate-secrets runbook (`.claude/skills/rotate-secrets/SKILL.md`). |
| `BETTER_AUTH_URL` | api (req.) | `http://localhost:3000` | The site's public origin. The API is served on it (`/rpc`, `/api`), so cookies are first-party; OAuth callbacks are built from it. |
| `WEB_URL` | api (req.), web (req.) | `http://localhost:3000` | The web app's origin: the API's CORS and trusted origin, links in emails, canonical URLs. |
| `MINIMUM_CLIENT_VERSION` | api | `0.0.0` | major.minor.patch. A client that sends an older `x-app-version` (a pre-release comes before its release), or one that isn't a version at all, gets `CLIENT_OUTDATED` and reloads. The web app sends none. |
| `ALERTMANAGER_URL` | api | unset | The cluster's Alertmanager. `system.alerting` (`/api/v1/system/alerting`) asks it whether Prometheus's always-firing Watchdog alert is still arriving and answers `ok` or `stale`, or `off` when this is unset; the uptime check outside the cluster fails on `stale` (deploy/README.md, "Observability"). The stack chart sets it when observability is on. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | api | empty | Both set: "Sign in with Google" (`google` feature). Redirect URI: `${BETTER_AUTH_URL}/api/auth/callback/google`. |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | api | empty | Both set: Cloudflare Turnstile on sign-up, emailed codes, password reset and the demo's guest sign-in (`captcha` feature; invisible on the demo unless Cloudflare wants an interaction). The site key reaches browsers through `system.info`. Cloudflare's always-pass test keys are in `.env.example`. |
| `DEMO_PASSWORD` | api | empty | Director's shared demo account (`demo@director.mmadan.in`): the password `bun run --filter @repo/api director:demo-account` gives it (deployed: `node dist/director-demo-account.mjs` in the api image; locally add `--force`). Set, `system.info` hands the email and password to the sign-in page, which shows them for anyone to use; empty, no demo account is offered. 8 to 128 characters; a secret like any other (production's is in `api.sops.yaml`), only public by design once the account exists. See [director.md](director.md#the-shared-demo-account). |
| `DEMO_GUESTS` | api | `off` | `on` gives each browser that tries the demo a private guest of its own (`/api/auth/sign-in/guest`, `system.info`'s `features.demoGuests`): a user with its own workspace and the seeded templates, deleted with everything it made a day later by the worker's `demo-retention` task. The shared demo account (`DEMO_PASSWORD`), when set, is then the fallback for a guest that can't be made. On in production and in `.env.example` (so locally and in the e2e runs).  See [director.md](director.md#the-demo). |
| `DEMO_GUEST_LIMIT` | api | `50` | How many demo guests may exist at once (each holds a workspace, its footage and an AI allowance for a day), counted atomically in Valkey. Past it the guest sign-in answers `DEMO_GUESTS_FULL` and the sign-in page falls back to the shared account. Sized to what the demo may spend; production sets it explicitly. |
| `DEMO_GUESTS_PER_ADDRESS` | api | `20` | How many demo guests one client IP may make an hour (better-auth's rate limiter, answering 429). High enough for a room of judges behind one address; with captcha on (Turnstile, invisible), a bot can't make them. |
| `DEMO_GUEST_LIVE_CALLS_PER_HOUR` | api | `6` | Live calls a demo guest may start an hour (a member gets 20). |
| `PASSWORD_BREACH_CHECK` | api | `on` in production, `off` otherwise | `on`: sign-ups and password changes refuse a password found in public breaches (Have I Been Pwned; only the first five characters of its SHA-1 hash are sent). Fails closed: while HIBP is unreachable they fail with a server error rather than let a password through unchecked. |

## Email (apps/notifications)

| Variable | Default / example | What it does |
|---|---|---|
| `SMTP_URL` | `smtp://localhost:51025` (Mailpit) | Where email is submitted. Required in production, and there it must authenticate and use TLS with the certificate checked: `smtps://no-reply%40example.com:<password>@mail.example.com:465`, or `smtp://…:587?requireTLS=true` for STARTTLS; `tls.servername=<public name>` when connecting by an internal name. Refused in production: no credentials, no TLS, `ignoreTLS=true`, `tls.rejectUnauthorized=false`. |
| `EMAIL_FROM` | `Director <no-reply@example.com>` | Sender. Required in production. Stalwart only accepts an address of the account `SMTP_URL` signs in as. |
| `NOTIFICATIONS_CRITICAL_CONCURRENCY` | 20 | Jobs per process on `notifications-critical`. |
| `MAILPIT_URL` | `http://localhost:58025` | Not read by any service: the tests (web, notifications) read caught emails from it. |

## Files (apps/api signs uploads, apps/worker checks them)

On when the chosen provider's bucket is set (`files` feature). Read by api and worker
(`storageEnv`).

| Variable | Read by | Default / example | What it does |
|---|---|---|---|
| `STORAGE_PROVIDER` | api, worker | `s3` | `s3` (RustFS, or any other S3-compatible provider) or `gcs` (Google Cloud Storage, its own JSON API). `gcs` without `GCS_BUCKET`, or the other provider's bucket set, stops the service at boot. |
| `S3_BUCKET` | api, worker | empty (`uploads` locally) | Turns uploads on for the `s3` provider. Refused with `gcs`. |
| `S3_REGION` | api, worker | `us-east-1` | |
| `S3_ENDPOINT` | api, worker | `http://localhost:59000` | The local RustFS; in a cluster, the data chart's (its `storage` Secret). Another S3-compatible provider: its S3 endpoint. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | api, worker | `rustfs`, `rustfs-secret` | In a cluster, generated by the data chart into the `storage` Secret. |
| `S3_FORCE_PATH_STYLE` | api, worker | `false` (`.env.example`: `true`) | For RustFS/MinIO-style servers without virtual-hosted buckets. |
| `GCS_BUCKET` | api, worker | empty | Turns uploads on for the `gcs` provider (refused with `s3`): production's `director-media-…` bucket. Application Default Credentials only (no key file, no `S3_*`); the VM's service account needs `roles/storage.objectAdmin` on the bucket and `roles/iam.serviceAccountTokenCreator` on itself (signed URLs sign through the IAM Credentials API's `signBlob`, since ADC from the metadata server has no private key of its own). |
| `STORAGE_ORIGIN` | web | `http://localhost:59000` | The storage origin browsers upload to and load from, allowed by the web app's CSP. With the `gcs` provider, `https://storage.googleapis.com` (production sets it): its `connect-src` already allows that origin for Director's pose model, but takes play from it too (`media-src`). |
| `FILE_SCANNER` | worker | `clamav` | `none` skips virus scanning: development only (refused in production when files are on). |
| `CLAMAV_URL` | worker | `tcp://localhost:53310` | clamd. |
| `FILES_CONCURRENCY` | worker | 2 | Uploads checked at once per process. |

## Webhooks (apps/webhooks)

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `STALWART_WEBHOOK_SECRET` | webhooks, local Stalwart (compose) | generated | The key our Stalwart mail server signs its webhook with (its WebHook `signatureKey`), at least 32 characters. On: hard bounces suppress the address. Comma-separated to accept a new and an old key while rotating (Stalwart signs with one). Without it `/webhooks/stalwart` answers 404. |

## Worker (apps/worker)

| Variable | Default | What it does |
|---|---|---|
| `RELAY_BATCH_SIZE` | 100 | Outbox rows claimed per transaction (at most 1000). |
| `RELAY_POLL_INTERVAL_MS` | 1000 | How often the relay looks even without a `NOTIFY`. |
| `AUDIT_CONCURRENCY` | 20 | Audit events written at once per process. |
| `OUTBOX_RETENTION_DAYS` | 7 | Published outbox rows are kept this long: the replay window for new consumers. |
| `PROCESSED_EVENT_RETENTION_DAYS` | 30 | `<schema>.processed_event` retention. |
| `AUDIT_RETENTION_MONTHS` | 13 | Audit log partitions older than this are dropped. |
| `WEBHOOK_HISTORY_DAYS` | 30 | Received provider events (the mail server's). |
| `NOTIFICATION_HISTORY_DAYS` | 90 | The email delivery log. |
| `RECORDING_CONCURRENCY` | 2 | Recorded attempts cut into takes at once per process (each holds its take, up to 15 MB, in memory). |
| `AI_URL`, `AI_SERVICE_SECRET` | unset | The AI service, as the API reaches it (below): the worker has it cut each recorded attempt into a take and record the take. Both or neither; without them recorded attempts wait for their take. |

## AI (apps/ai; apps/api and apps/web call it)

See [python-services.md](python-services.md). The `ai` feature in the API is on when
both `AI_URL` and `AI_SERVICE_SECRET` are set.

| Variable | Read by | Default / example | What it does |
|---|---|---|---|
| `AI_URL` | api, worker | `http://localhost:8000` | Where the API (and the worker, for cutting recorded attempts into takes) calls the AI service. |
| `AI_SERVICE_SECRET` | ai (req.), api, worker | generated | At least 32 characters. The API and the worker sign a 60-second token for every call with it; the service verifies it. |
| `API_URL` | web | `http://localhost:3001` | Where `/rpc`, `/api` and `/docs` are forwarded in local development and e2e (the gateway does it when deployed). Read when the web app is built, not when it starts: the image keeps the default, which clusters never use. |
| `AI_MONTHLY_TOKENS_PER_ORG` | ai | 2000000 | Tokens a workspace may use per calendar month. |
| `AI_MONTHLY_TOKENS_PER_DEMO_GUEST` | ai | 300000 | Tokens a demo guest's workspace may use per calendar month, at most (it lasts a day; the guests' purge adds what they spent to `ai.demo_usage`). |

## Director (apps/ai watches shorts; apps/api reads YouTube)

The `director` feature in the API is on when `YOUTUBE_API_KEY` is set and the `ai` and
`files` features are; the AI service answers `FEATURE_DISABLED` for Director until
`DIRECTOR_MODEL` is set. Both are real Google services, empty in `.env.example` until you
set a real key: integration and e2e suites start the mock Google (`packages/fake-google`)
themselves, never `bun dev` or `bun dev:full`. See [director.md](director.md).

| Variable | Read by | Default / example | What it does |
|---|---|---|---|
| `DIRECTOR_MODEL` | ai | empty in `.env.example` | The Gemini model, by its Gemini API name (`gemini-3.8-flash`). Gemini because it watches a YouTube video from its URL. Unset: Director off (and setting it without `GOOGLE_API_KEY` fails at boot). |
| `GOOGLE_API_KEY` | ai (req. with `DIRECTOR_MODEL`) | empty in `.env.example` | The Gemini API key, or, with `GOOGLE_VERTEX`, a Vertex key bound to a service account. |
| `GOOGLE_BASE_URL` | ai | empty in `.env.example` | Another Gemini API endpoint: a gateway, or unset for Google's. Must be HTTPS in production. |
| `GOOGLE_VERTEX` | ai, indexer | `true` in `.env.example` | `true`: Gemini through Vertex AI, billed through Cloud Billing (so a project's Cloud credits pay): express mode with `GOOGLE_API_KEY` a Vertex key bound to a service account, or, with no key (the Cloud Run indexer), Application Default Credentials, the service's own account. Needs `GOOGLE_CLOUD_PROJECT` once something calls Gemini (the service: once `GOOGLE_API_KEY` is also set; the indexer: always); `true` with neither key nor project is harmless for the service, so a key added later is billed through Vertex with no extra step. |
| `VERTEX_LOCATION` | ai | `global` | The Vertex location every Gemini call addresses its model at. `global` by default: newer models (`gemini-4-argon`) are served only there, and an API key routes a bare model name to `us-central1` regardless of this setting. |
| `DIRECTOR_TOKENS_PER_PLAN` | ai | 200000 | Cap per plan: watching the whole short and thinking (at least 10000, at most 2000000, what the Cloud Run indexer accepts). |
| `DIRECTOR_TOKENS_PER_LOCATE` | ai | 12000 | Cap per locate (a mark on the member's camera): one camera frame (at least 2000). |
| `DIRECTOR_TOKENS_PER_REVIEW` | ai | 120000 | Cap per take review: watching one take (at least 10000). |
| `DIRECTOR_TOKENS_PER_PUBLISH_COPY` | ai | 20000 | Cap per YouTube post Director writes for a video: its plan's text, no video (at least 2000). |
| `DIRECTOR_TOKENS_PER_ALIGNMENT` | ai | 12000 | Cap per match cut Director lines up: two small frames for Gemini to find the anchor in (2000 to 100000). |
| `DIRECTOR_TOKENS_PER_REVISE` | ai | 30000 | Cap per re-plan of a member's version of a template: its plan's text and their version, no video (at least 2000). |
| `INDEX_MODEL` | ai | `gemini-4-argon` | The model a plan job indexes a short with, unattended, so it can be a different, more thorough model than `DIRECTOR_MODEL`'s live locates and reviews. |
| `INDEX_FALLBACK_MODEL` | ai | `gemini-3.1-pro-preview` | Tried once after `INDEX_MODEL`'s own retries on a plan are spent (a transient failure, not a refusal). |
| `MEDIA_BUCKET` | ai, indexer | empty in `.env.example` | The Cloud Storage bucket a short's original audio is captured into while it's indexed (`audio/<videoId>.m4a`, yt-dlp then an upload with Application Default Credentials): production's `director-media-…`, the same bucket as `GCS_BUCKET`, which apps/api signs links to. The account indexing (the VM's, or the indexer's on Cloud Run) needs `roles/storage.objectAdmin` on it. The worker also keeps the default images of plans' assets there (`director-assets/<planId>/`, `ASSET_MODEL`). Unset: the audio isn't captured and no asset images are drawn; plans are still written. |
| `INDEXER_URL` | ai (worker), indexer (required) | unset | The Cloud Run indexer (`app/indexer.py`, [deploy.md](deploy.md#the-cloud-run-indexer)), its URL with no trailing slash. The worker sends each plan job's short there, with an ID token for this URL from the metadata server, so Gemini's long video calls and the audio download happen off the VM; unset, the worker indexes in-process, the same way. For the indexer, its own URL: the only audience its ID tokens may name. HTTPS in production. |
| `INDEXER_INVOKER` | indexer (required) | unset | The one service account allowed to call the indexer (production: the VM's, `director-vm@…`). Cloud Run's IAM already lets only its invokers in; the indexer checks the ID token's email again itself. |
| `GOOGLE_CERTS_URL` | indexer, clipper, aligner | `https://www.googleapis.com/oauth2/v1/certs` | Where Google publishes the keys its ID tokens are signed with. Only tests point it elsewhere; production refuses anything but HTTPS. |
| `CLIPPER_URL` | ai (required in production), clipper (required) | unset | The Cloud Run clipper (`app/clipper.py`, [deploy.md](deploy.md#the-cloud-run-clipper)), its URL with no trailing slash. The AI service sends each recorded attempt there to be cut into a take, with an ID token for this URL from the metadata server, so a member's footage is decoded in a container with no secrets, off the VM. Unset (development and tests only: production refuses to start without it), the AI service cuts it itself with its own ffmpeg, the same way. For the clipper, its own URL: the only audience its ID tokens may name. HTTPS in production. |
| `CLIPPER_INVOKER` | clipper (required) | unset | The one service account allowed to call the clipper (production: the VM's, `director-vm@…`, which the AI service runs as). |
| `ALIGNER_URL` | ai, aligner (required) | unset | The Cloud Run aligner (`app/aligner.py`, [deploy.md](deploy.md#the-cloud-run-aligner)), its URL with no trailing slash. The ai service sends each match cut there to be lined up (ffmpeg, OpenCV and a Gemini call), with an ID token for this URL from the metadata server; unset, it lines them up in-process, the same way. For the aligner, its own URL: the only audience its ID tokens may name. HTTPS in production. |
| `ALIGNER_INVOKER` | aligner (required) | unset | The one service account allowed to call the aligner (production: the VM's, `director-vm@…`), checked again by the aligner itself. |
| `TTS_MODEL` | ai | `gemini-3.8-flash-tts` | Gemini's text-to-speech model, behind `director.speak` (a line in Director's voice). On with Director; the API keeps each spoken line in object storage, so it needs uploads on too. |
| `DIRECTOR_TOKENS_PER_SPEECH` | ai | 3000 | What one spoken line may take (about 25 tokens a second of speech; at least 1000). A line waits for a budget that holds all of it: Vertex refuses a cap on the TTS model's output. |
| `ASSET_MODEL` | ai | `gemini-nano-banana-2.1` | Nano Banana, by its short name: draws the default image of each still a plan's assets name (a chart, a headline card, an end card), right after the plan is indexed, from the asset's prompt (`app/assets.py`), at most 5 a plan and 30 a day per member. On with Director and `MEDIA_BUCKET`, where the images are kept (`director-assets/<planId>/<assetId>.png`); the worker's account needs to write there. |
| `DIRECTOR_TOKENS_PER_ASSET` | ai | 6000 | What one default asset image may take (a 1K image is about 1,300 output tokens with the model's thinking; at least 2000). An image waits for a budget that holds all of it. |
| `VEO_MODEL` | ai | `veo-3.1-lite-generate-001` | Veo, by its short name: makes an 8-second silent B-roll clip for a gap in a member's video when they ask for one in the asset picker (`app/clips.py`), at most 3 a video and none for demo guests, kept beside the slot's images (`director-assets/<planId>/<slotId>/<id>.mp4`). Empty turns clips off; a gap's Create tab then draws stills. A video that uses a clip is published with YouTube's altered or synthetic content flag. |
| `VEO_LOCATION` | ai | `us-central1` | The Vertex AI location Veo is called in: Veo isn't served from `global`, where `VERTEX_LOCATION` points the Gemini models. |
| `DIRECTOR_TOKENS_PER_CLIP` | ai | 60000 | What one Veo clip counts against the workspace's AI allowance, standing for its price by the second (at least 2000). |
| `YOUTUBE_API_KEY` | api | empty in `.env.example` | YouTube Data API v3 key: whether a pasted link is a Short Director can film (its length), before it's indexed. Unset: Director off. |
| `YOUTUBE_API_URL` | api | `https://www.googleapis.com/youtube/v3` | Where the API reads YouTube: real by default, a gateway otherwise (`.env.example` ships it commented out). Must be HTTPS in production. |
| `PEXELS_API_KEY` | api | empty in `.env.example` | A Pexels API key (free, pexels.com/api): stock photos in the asset picker's Stock tab (`apps/api/src/modules/assets/stock`). Results are cached a day; a photo the member uses is copied into storage and credited in the YouTube description. Pexels allows 200 requests an hour and 20,000 a month per key. Unset with `PIXABAY_API_KEY`: the `stock` feature is off and the tab is hidden. |
| `PIXABAY_API_KEY` | api | empty in `.env.example` | A Pixabay API key (free, pixabay.com/api/docs): the Stock tab's second source, on the same terms (100 requests a minute; results cached a day, used photos copied into storage, never hotlinked). |
| `PEXELS_API_URL` | api | `https://api.pexels.com` | Where the API reads Pexels: real by default, a stand-in in tests (`.env.example` ships it commented out). Must be HTTPS in production. |
| `PIXABAY_API_URL` | api | `https://pixabay.com` | Where the API reads Pixabay (its search is `<url>/api/`), as above. Must be HTTPS in production. |
| `GOOGLE_CLOUD_PROJECT` | api; ai (req. with `GOOGLE_VERTEX` once `GOOGLE_API_KEY` is set) | unset | The Google Cloud project Director live (`/api/live`: Gemini Live on Vertex AI, talking with the member on the shoot screen) runs in and bills to; `system.info` reports it as the `live` feature. Unset: `/api/live` answers `FEATURE_DISABLED` and the shoot screen says Director can't join, takes still work. apps/ai reads the same project to address Vertex AI models by their full resource name. |
| `LIVE_LOCATION` | api | `us-central1` | The Vertex AI region of Director live's endpoint (`wss://<region>-aiplatform.googleapis.com/...`). |
| `LIVE_MODEL` | api | `gemini-live-2.5-flash-native-audio` | The Live API model, by its Vertex AI name. |
| `LIVE_PROACTIVE_AUDIO` | api | `true` | Proactive audio on the Live model: Director may stay quiet for what isn't meant for it (chatter, someone else in the room, the lines during an attempt). Turn off for a model that refuses it at setup. |
| `LIVE_AFFECTIVE_DIALOG` | api | `true` | Affective dialog on the Live model: Director matches the member's tone. Turn off for a model that refuses it at setup. |
| `LIVE_API_URL` | api | unset | Where the API reaches the Live API: unset, the region's own endpoint from `LIVE_LOCATION`. Tests point it at the mock Google's stand-in (`ws://127.0.0.1:<port>/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`), whose bearer token is its key. Must be `wss://` in production. |
| `CHAT_MODEL` | api | `gemini-3.8-flash` | Director's slower line (`director.chat`), turn by turn when Gemini Live can't run: the Gemini model on Vertex AI, addressed at the global endpoint, billed to `GOOGLE_CLOUD_PROJECT` like Live (off without it). |
| `CHAT_API_URL` | api | unset | Where the slower line reaches Vertex AI's generateContent: unset, `https://aiplatform.googleapis.com`. Tests point it at the mock Google (`http://127.0.0.1:<port>`), whose bearer token is the Live one. Must be `https://` in production. |
| `LIVE_OFF_USERS` | api | empty | User ids, comma-separated, who get the slower line instead of Gemini Live (their Live connection is refused as off): to try the slower line, or to take one member off Live. |
| `GOOGLE_ACCESS_TOKEN` | api | unset | Local development only: a Google access token (`gcloud auth print-access-token`, valid for an hour) used in place of the GCE metadata server's. Production refuses to start with it set. |
| `BIGQUERY_DATASET` | api, ai | unset | The BigQuery dataset product events are streamed into, in its `events` table: `cut_saved`, `published`, `call_started` and `director_turn` (one per live turn, no words) from the api (`AnalyticsService`, `src/modules/analytics`), `indexed` (with the model that wrote the plan) once a plan is ready and `take_reviewed` with its score once a review finishes, from apps/ai (`app/analytics.py`). Letters, digits and underscores. Needs `GOOGLE_CLOUD_PROJECT`, above (both services refuse to start without it). Unset: analytics is off, nothing is written. |

## Web (apps/web)

Server-only: nothing environment-specific is built into the browser bundle.

| Variable | Default | What it does |
|---|---|---|
| `WEB_URL` | required | This site's origin (canonical URLs, sitemap). |
| `API_URL`, `STORAGE_ORIGIN` | see above | |
| `RELEASE` | `dev` | Sent to the API as `x-app-version`. |
| `SKIP_ENV_VALIDATION` | unset | `1` only for `next typegen` inside `check-types`. |

## Tests and tooling

Not read by any service.

| Variable | Read by | What it does |
|---|---|---|
| `E2E_BASE_URL` | web Playwright | Default `WEB_URL`. |
| `E2E_GOOGLE_EMAIL`, `E2E_GOOGLE_PASSWORD` | `apps/web/e2e/google.spec.ts` | A real Google account; the spec is skipped without them. |
| `STALWART_URL` | `apps/webhooks/test/stalwart.integration.test.ts` | The local Stalwart's management API (`http://localhost:58080`, `bun run db:up:mail`); the test sends real mail through it and is skipped without it. |
| `STALWART_SMTP_URL` | `apps/notifications/test/stalwart.integration.test.ts`, and the webhooks one | Submission to the local Stalwart, `smtps://no-reply:no-reply-password@localhost:51465?tls.rejectUnauthorized=false`; the notifications test is skipped without it. |
| `STALWART_ADMIN_PASSWORD`, `STALWART_SMTP_PASSWORD` | `docker-compose.yml`, the webhooks test | The local Stalwart's admin and `no-reply@director-editor.test` passwords (default `stalwart-admin`, `no-reply-password`). |
| `LOAD_USERS` | `apps/api/src/load-users.ts` | Signed-in users for the fuzzing's sessions (default 50, at most 1000). |
| `PG_CONTAINER` | `scripts/restore-drill.ts` | Run the drill against another Postgres container (CI). |
