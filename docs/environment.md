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
  billing and AI are on exactly when their variables are set (`apps/api/src/features.ts`);
  push platforms likewise (`apps/notifications/src/env.ts`), and the mobile app's links
  and passkeys (`apps/web/src/lib/app-links.ts`). A half-configured feature
  (a Google client id without its secret, two of three FCM values) fails at boot.
  Disabled features answer `FEATURE_DISABLED`, and clients read the same map from
  `system.info` to hide their UI.
- **Production refuses dev stand-ins.** With `NODE_ENV=production` the services refuse
  to start with `STRIPE_API_URL`, `WEBHOOK_ALLOWED_PRIVATE_ADDRESSES`, `FILE_SCANNER=none`
  (with files on), `SMS_PROVIDER=email`, the push and Twilio test hooks,
  `AI_EMBEDDINGS=hashing` or a `local:` model. Variables wrapped in `requiredInProduction`
  have a localhost default in development and are mandatory in production.

## Setting values

`bun run setup` copies `.env.example` to `.env`, adds variables that are missing from an
existing `.env`, and replaces every `change-me` / `replace-me` placeholder with a fresh
secret (`ENCRYPTION_KEYS` as `<yyyy-mm>:<base64>`, a P-256 pair for the VAPID keys, 32
random bytes for the rest). Re-running it keeps existing values.

To set one value without opening `.env`:

```sh
bun run env:set STRIPE_SECRET_KEY=sk_test_...
echo "sk_test_..." | bun run env:set STRIPE_SECRET_KEY   # value from stdin, not argv
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
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | An OTLP/HTTP collector, e.g. `http://otel-collector:4318`, or locally Jaeger at `http://localhost:54318` (in the `full` profile). Set, every service exports traces and metrics there and log lines carry `trace_id`; unset, nothing starts. |
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
`BETTER_AUTH_URL`, `API_URL`, `AI_URL`, `APP_ORIGINS`, `EXPO_PUBLIC_API_URL`, the
database, Valkey and Mailpit URLs, and `STRIPE_API_URL` when you set it), and writes the
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
| `MOBILE_WEB_PORT` | 3005 | apps/mobile `serve:web`, the mobile Playwright suite. Not 3100, which is stack 1's web port. |
| `AI_PORT` | 8000 | apps/ai `dev` and `start` (`fastapi --port`) |
| `EMAIL_PREVIEW_PORT` | 3030 | packages/email `dev` |
| `EXPO_PORT` | 8081 | apps/mobile `dev` (Expo's bundler) |
| `STORYBOOK_PORT` | 6006 | packages/ui `storybook` |
| `STRIPE_FAKE_PORT` | 12111 | the fake Stripe (`bun run stripe:fake`, the e2e run) |

## Auth and the API (apps/api)

| Variable | Read by | Default / example | What it does |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | api (req.) | generated | At least 32 characters. Signs sessions and encrypts what better-auth stores (OAuth tokens, 2FA secrets and backup codes, JWT signing keys). |
| `BETTER_AUTH_SECRETS` | api | unset | Rotating the one above: `2:<secret>,1:<secret>`, newest first (each at least 32 characters). The newest signs and encrypts; the rest, and `BETTER_AUTH_SECRET`, still decrypt. Then `bun run secrets:reencrypt`. See the rotate-secrets runbook (`.claude/skills/rotate-secrets/SKILL.md`). |
| `BETTER_AUTH_URL` | api (req.), ai | `http://localhost:3000` | The site's public origin. The API is served on it (`/rpc`, `/api`), so cookies are first-party; OAuth callbacks, the OAuth issuer and MCP resource URLs are built from it. The AI service needs it (with `API_URL`) for its MCP server. |
| `WEB_URL` | api (req.), web (req.), notifications, `apps/mobile/scripts/serve-web.ts` | `http://localhost:3000` | The web app's origin: the API's CORS and trusted origin, links in messages, canonical URLs. Notifications: required in production. The mobile web build's server forwards the captcha page to it. |
| `APP_ORIGINS` | api | `http://localhost:3005` | Other origins allowed to sign users in, comma-separated (the mobile app's web build), passkeys included. Native apps need nothing here. |
| `ANDROID_CERT_FINGERPRINTS` | api, web | unset | SHA-256 fingerprints of the Android app's signing certificates, comma-separated. The API accepts passkeys from the app signed with each (Android reports the app, not the site, as their origin); the web app names them in `assetlinks.json`. |
| `MINIMUM_CLIENT_VERSION` | api | `0.0.0` | major.minor.patch. The mobile app sends its version as `x-app-version`; one below this (a pre-release comes before its release) or one that isn't a version at all gets `CLIENT_OUTDATED`, and the app shows its update screen. The web app sends none. |
| `ALERTMANAGER_URL` | api | unset | The cluster's Alertmanager. `system.alerting` (`/api/v1/system/alerting`) asks it whether Prometheus's always-firing Watchdog alert is still arriving and answers `ok` or `stale`, or `off` when this is unset; the uptime check outside the cluster fails on `stale` (deploy/README.md, "Observability"). The stack chart sets it when observability is on. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | api | empty | Both set: "Sign in with Google" (`google` feature). Redirect URI: `${BETTER_AUTH_URL}/api/auth/callback/google`. |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | api | empty | Both set: Cloudflare Turnstile on sign-up, emailed codes and password reset (`captcha` feature). The site key reaches browsers through `system.info`. Cloudflare's always-pass test keys are in `.env.example`. |
| `PASSWORD_BREACH_CHECK` | api | `on` in production, `off` otherwise | `on`: sign-ups and password changes refuse a password found in public breaches (Have I Been Pwned; only the first five characters of its SHA-1 hash are sent). Fails closed: while HIBP is unreachable they fail with a server error rather than let a password through unchecked. |
| `ENCRYPTION_KEYS` | api (req.), webhooks (req.) | generated | `id:base64key[,id:base64key…]`, 32-byte keys. The first encrypts, any listed key decrypts; prepend a new one to rotate. Encrypts webhook signing secrets at rest. |
| `UNSUBSCRIBE_SECRET` | api (req.), notifications (req.) | generated | At least 32 characters. Notifications signs one-click unsubscribe links, the API checks them. |

## Email (apps/notifications)

| Variable | Default / example | What it does |
|---|---|---|
| `SMTP_URL` | `smtp://localhost:51025` (Mailpit) | Where email is submitted. Required in production, and there it must authenticate and use TLS with the certificate checked: `smtps://no-reply%40example.com:<password>@mail.example.com:465`, or `smtp://…:587?requireTLS=true` for STARTTLS; `tls.servername=<public name>` when connecting by an internal name. Refused in production: no credentials, no TLS, `ignoreTLS=true`, `tls.rejectUnauthorized=false`. |
| `EMAIL_FROM` | `Boilerplate <no-reply@example.com>` | Sender. Required in production. Stalwart only accepts an address of the account `SMTP_URL` signs in as. |
| `DIGEST_HOUR` | 8 | Local hour (each user's time zone) from which their daily digest goes out. |
| `NOTIFICATIONS_CRITICAL_CONCURRENCY` | 20 | Jobs per process on `notifications-critical`. |
| `NOTIFICATIONS_BULK_CONCURRENCY` | 5 | Jobs per process on `notifications-bulk`. |
| `MAILPIT_URL` | `http://localhost:58025` | Not read by any service: the tests (web, mobile, Maestro, notifications) read caught emails from it. |

## Texts (apps/notifications)

| Variable | Default / example | What it does |
|---|---|---|
| `SMS_PROVIDER` | `email` outside production, unset in production | `twilio`, or `email` (delivers texts to Mailpit as mail to `<digits>@sms.test`; refused in production). Unset: nothing is texted. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | empty | All three required for `twilio`. `TWILIO_FROM` is an E.164 number or a Messaging Service SID (`MG…`). |
| `TWILIO_API_URL` | unset | Test hook: where Twilio's API lives. Refused in production. |

## Push (apps/notifications; apps/api hands out the VAPID public key)

Each platform is on when all of its variables are set.

| Variable | Default / example | What it does |
|---|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | generated by setup | Web Push key pair. The API also reads the public key and returns it from `system.info`. By hand: `bunx web-push generate-vapid-keys`. |
| `VAPID_SUBJECT` | `mailto:dev@example.com` | `mailto:` or `https:` contact for push services. |
| `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` | empty | Android: a Firebase service account. |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`, `APNS_BUNDLE_ID` | empty | iOS: an APNs auth key (`.p8`). |
| `APNS_URL` | `https://api.push.apple.com` | `https://api.sandbox.push.apple.com` for development builds. |
| `FCM_TOKEN_URL`, `FCM_API_URL`, `WEB_PUSH_TEST_ORIGIN` | unset | Test hooks (fake push servers). Refused in production. |

## Files (apps/api signs uploads, apps/worker checks them)

On when `S3_BUCKET` is set (`files` feature). Read by api and worker (`storageEnv`).

| Variable | Read by | Default / example | What it does |
|---|---|---|---|
| `S3_BUCKET` | api, worker | empty (`uploads` locally) | Turns uploads on. |
| `S3_REGION` | api, worker | `us-east-1` | |
| `S3_ENDPOINT` | api, worker | `http://localhost:59000` | The local RustFS; in a cluster, the data chart's (its `storage` Secret). Another S3-compatible provider: its S3 endpoint. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | api, worker | `rustfs`, `rustfs-secret` | In a cluster, generated by the data chart into the `storage` Secret. |
| `S3_FORCE_PATH_STYLE` | api, worker | `false` (`.env.example`: `true`) | For RustFS/MinIO-style servers without virtual-hosted buckets. |
| `STORAGE_ORIGIN` | web | `http://localhost:59000` | The storage origin browsers upload to and load from, allowed by the web app's CSP. |
| `FILE_SCANNER` | worker | `clamav` | `none` skips virus scanning: development only (refused in production when files are on). |
| `CLAMAV_URL` | worker | `tcp://localhost:53310` | clamd. |
| `FILES_CONCURRENCY` | worker | 2 | Uploads checked at once per process. |

## Billing (apps/api; apps/webhooks receives Stripe's events)

On when `STRIPE_SECRET_KEY` and both prices are set (`billing` feature); any other
combination fails at boot. See [files-and-billing.md](files-and-billing.md).

| Variable | Read by | Default / example | What it does |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | api, fake Stripe | empty | `sk_test_…`, `sk_live_…` or a restricted `rk_…` key. |
| `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY` | api, fake Stripe | empty | Recurring price ids (`price_…`) for the Pro plan. |
| `STRIPE_TRIAL_DAYS` | api | 14 | Trial on an organization's first subscription; 0 turns trials off. |
| `STRIPE_API_URL` | api | empty | Points the Stripe client at the fake Stripe (`http://127.0.0.1:<STRIPE_FAKE_PORT>`). Refused in production. |
| `STRIPE_WEBHOOK_SECRET` | webhooks, fake Stripe | empty | `whsec_…`. Without it `/webhooks/stripe` answers 404. |
| `STRIPE_FAKE_WEBHOOK_URL` | fake Stripe | `http://localhost:<WEBHOOKS_PORT>/webhooks/stripe` | Where the fake sends its events. Its own port is `STRIPE_FAKE_PORT` ([Local app ports](#local-app-ports)). |

## Webhooks (apps/webhooks, and apps/api for endpoint settings)

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `STALWART_WEBHOOK_SECRET` | webhooks, local Stalwart (compose) | generated | The key our Stalwart mail server signs its webhook with (its WebHook `signatureKey`), at least 32 characters. On: hard bounces suppress the address. Comma-separated to accept a new and an old key while rotating (Stalwart signs with one). Without it `/webhooks/stalwart` answers 404. |
| `WEBHOOK_ALLOWED_PRIVATE_ADDRESSES` | api, webhooks | empty (`127.0.0.1` in `.env.example`) | Exact private IPs customer endpoints may use, for local receivers and tests. Must be empty in production. |
| `WEBHOOK_DELIVERY_CONCURRENCY` | webhooks | 20 | Deliveries in flight per process. |
| `WEBHOOK_TIMEOUT_MS` | webhooks | 15000 | Per delivery attempt, at most 60000. |
| `WEBHOOK_AUTO_DISABLE_HOURS` | webhooks | 120 | An endpoint failing this long without one success is disabled (and its admins notified). |

## Worker (apps/worker)

| Variable | Default | What it does |
|---|---|---|
| `RELAY_BATCH_SIZE` | 100 | Outbox rows claimed per transaction (at most 1000). |
| `RELAY_POLL_INTERVAL_MS` | 1000 | How often the relay looks even without a `NOTIFY`. |
| `AUDIT_CONCURRENCY` | 20 | Audit events written at once per process. |
| `OUTBOX_RETENTION_DAYS` | 7 | Published outbox rows are kept this long: the replay window for new consumers. |
| `PROCESSED_EVENT_RETENTION_DAYS` | 30 | `<schema>.processed_event` retention. |
| `AUDIT_RETENTION_MONTHS` | 13 | Audit log partitions older than this are dropped. |
| `WEBHOOK_HISTORY_DAYS` | 30 | Webhook delivery logs and received provider events. |
| `NOTIFICATION_HISTORY_DAYS` | 90 | Notification delivery log, and in-app notifications read longer ago. |

## AI (apps/ai; apps/api and apps/web call it)

See [python-services.md](python-services.md). The `ai` feature in the API is on when
both `AI_URL` and `AI_SERVICE_SECRET` are set.

| Variable | Read by | Default / example | What it does |
|---|---|---|---|
| `AI_URL` | api, web | `http://localhost:8000` | Where the API calls the AI service. The web app forwards `/ai/mcp` there in local development. |
| `AI_SERVICE_SECRET` | ai (req.), api | generated | At least 32 characters. The API signs a 60-second token for every call with it; the service verifies it. |
| `API_URL` | web, ai, `apps/mobile/scripts/serve-web.ts` | `http://localhost:3001` | Web: where `/rpc`, `/api` and `/docs` are forwarded in local development and e2e (the gateway does it when deployed). Read when the web app is built, not when it starts: the image keeps the default, which clusters never use. AI: where its MCP server fetches the API's JWKS. |
| `AI_MODEL` | ai | unset (`local:extractive` in `.env.example`) | A Pydantic AI model name (`anthropic:claude-sonnet-5`, `openai:gpt-5`). Unset: the assistant is off. `local:extractive` quotes the best passage with no model (refused in production). |
| `AI_FALLBACK_MODEL` | ai | unset | Used when the main model fails. |
| `AI_EMBEDDINGS` | ai | `hashing` | An embedding model name (`openai:text-embedding-3-small`) giving 1536 dimensions, or `hashing` (lexical, refused in production). |
| `AI_MIN_RELEVANCE` | ai | 0 | Cosine similarity below which a passage isn't used (provider embeddings; 0 lets the model judge). Calibrate with the evals. |
| `AI_MONTHLY_TOKENS_PER_ORG` | ai | 2000000 | Tokens a workspace may use per calendar month. |
| `AI_TOKENS_PER_RUN` | ai | 20000 | Cap per answer (at least 1000). |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | ai (the Pydantic AI providers, not `settings.py`) | unset | The provider key for the model names above. Not in `.env.example`: add with `bun run env:set`. |

## Web (apps/web)

Server-only: nothing environment-specific is built into the browser bundle.

| Variable | Default | What it does |
|---|---|---|
| `WEB_URL` | required | This site's origin (canonical URLs, sitemap). |
| `API_URL`, `AI_URL`, `STORAGE_ORIGIN` | see above | |
| `APPLE_TEAM_ID`, `IOS_BUNDLE_ID` | unset | The iOS app (`ABCDE12345`, `com.boilerplate.app`): `/.well-known/apple-app-site-association` names it for links and passkeys. |
| `ANDROID_PACKAGE`, `ANDROID_CERT_FINGERPRINTS` | unset | The Android app and the SHA-256 fingerprints of its signing certificates, comma-separated (`AB:CD:…`): `/.well-known/assetlinks.json` names them. Optional, all four or none: with none set both files answer 404; with only some, the web app refuses to start and names the missing ones. The API and the mobile build read the fingerprints too ("Auth and the API", "Mobile"). |
| `RELEASE` | `dev` | Sent to the API as `x-app-version`. |
| `SKIP_ENV_VALIDATION` | unset | `1` only for `next typegen` inside `check-types`. |

## Mobile (apps/mobile)

Read at build time (`app.config.ts`, `src/lib/config.ts`).

| Variable | Default | What it does |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | `http://localhost:3000` | The site's origin; on a phone use your machine's LAN address. EAS builds get it per EAS environment (`bunx eas-cli env:create --environment production --name EXPO_PUBLIC_API_URL --value …`). |
| `EAS_PROJECT_ID` | empty | From `bunx eas-cli init`. Enables over-the-air updates; only EAS builds need it. |
| `APP_VARIANT` | `development` | `development`, `preview` or `production`: app name and identifiers. Set by the profiles in `eas.json`. |
| `APPLE_TEAM_ID`, `ANDROID_CERT_FINGERPRINTS` | unset | The same values the web app has (above). With one set and an https `EXPO_PUBLIC_API_URL`, the build claims the site's links and passkeys on that platform (`associatedDomains`, `intentFilters`); unset, it claims nothing. Set per EAS environment for store builds. |

## Tests and tooling

Not read by any service.

| Variable | Read by | What it does |
|---|---|---|
| `E2E_BASE_URL` | web Playwright | Default `WEB_URL`. |
| `E2E_MOBILE_URL` | mobile Playwright | Default `http://localhost:<MOBILE_WEB_PORT>`. |
| `E2E_GOOGLE_EMAIL`, `E2E_GOOGLE_PASSWORD` | `apps/web/e2e/google.spec.ts` | A real Google account; the spec is skipped without them. |
| `E2E_CIMD_CLIENT_ID`, `E2E_CIMD_REDIRECT_URI` | `apps/api/test/oauth.integration.test.ts` | A real Client ID Metadata Document; the test is skipped without them. |
| `STALWART_URL` | `apps/webhooks/test/stalwart.integration.test.ts` | The local Stalwart's management API (`http://localhost:58080`, `bun run db:up:mail`); the test sends real mail through it and is skipped without it. |
| `STALWART_SMTP_URL` | `apps/notifications/test/stalwart.integration.test.ts`, and the webhooks one | Submission to the local Stalwart, `smtps://no-reply:no-reply-password@localhost:51465?tls.rejectUnauthorized=false`; the notifications test is skipped without it. |
| `STALWART_ADMIN_PASSWORD`, `STALWART_SMTP_PASSWORD` | `docker-compose.yml`, the webhooks test | The local Stalwart's admin and `no-reply@boilerplate.test` passwords (default `stalwart-admin`, `no-reply-password`). |
| `LOAD_USERS` | `apps/api/src/load-users.ts` | Signed-in users for k6 (default 50, at most 1000). |
| `BASE_URL`, `PROFILE`, `TARGET_RPS`, `DURATION` | `load/api.ts` | k6 target (default `http://host.docker.internal:<API_PORT>`), `smoke` or `load`, rate (default 200), hold time (default `5m`). |
| `PG_CONTAINER` | `scripts/restore-drill.ts` | Run the drill against another Postgres container (CI). |
| `EVAL_JUDGE_MODEL`, `EVAL_MIN_PASS_RATE` | `apps/ai/evals` | LLM-judged rubrics, and the pass rate below which the run fails (default 1.0). |
