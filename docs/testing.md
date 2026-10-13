# Testing

| Layer | Where | Command | Needs |
|---|---|---|---|
| Unit | `src/**/*.test.ts(x)` in each package, `apps/mobile/src`, `apps/ai/tests` (not marked `integration`) | `bun run test` | nothing (cached by turbo) |
| Integration | `test/` in each service, `packages/db/test`, `packages/nest-common/test`, `apps/web/test` (in Chromium), `apps/ai` tests marked `integration` | `bun run test:integration` | the core: Postgres, Valkey, Mailpit (started for you) |
| Integration, file uploads | the suites tagged `files` in `apps/api`, `apps/worker`, `packages/nest-common` and `apps/web/test` | `bun run test:integration:files` | the core plus RustFS and ClamAV (started for you) |
| Coverage | every suite merged, every file at 100% | `bun run test:coverage` | the full profile (`bun run db:up:full`) |
| End to end | `apps/web/e2e`, `apps/mobile/e2e`, then the k6 smoke and the fuzzing | `bun run test:e2e` | `bun run db:up:full`, nothing else running on the stack's ports |
| Components | every story in `packages/ui` | `bun run --cwd packages/ui test:stories`, `test:visual` | Chromium; Docker for `test:visual` |
| Load | `load/api.ts` (k6) | `bun run test:load` | a running API, Docker |
| Fuzzing | every operation in `apps/api/openapi.json` and `apps/ai/openapi.json` (Schemathesis, `schemathesis.toml`) | `bun run test:fuzz` | a running API and AI service, uv |
| Evals | `apps/ai/evals` | `bun run --cwd apps/ai evals` | nothing with the local stand-ins |
| Restore drill | `scripts/restore-drill.ts` | `bun run db:restore-drill` | the local Postgres container |

On commit, the pre-commit hook (`scripts/pre-commit.ts`) checks the staged files. First
lint-staged formats and lints them (Biome, ruff, prisma format, Squawk on new migrations,
`tofu fmt`, the SOPS check) and restages what it fixed, alone, since it hides and
restores the unstaged changes while it works. Then the scans run side by side (as many as
the machine has cores, less one): gitleaks scans them for secrets
(`scripts/secret-scan.ts`); a staged Dockerfile, or anything under `deploy/` or `infra/`,
adds Trivy's misconfiguration scan (`scripts/misconfig.ts`); a staged `bun.lock` or
`apps/ai/uv.lock` adds OSV's (`scripts/osv.ts`); a staged workflow adds actionlint and
zizmor, a shell script shellcheck, a Dockerfile hadolint, OpenTofu tflint and
`renovate.json5` Renovate's config validator (`scripts/linters.ts`). The two scans are
the Security workflow's, with the same versions and configuration (`trivy.yaml`, `osv-scanner.toml`), and the linters are the
lint job's, so what passes the hook passes those jobs. Each uses a local binary of CI's
version, else its image in Docker; with neither, the commit stops and says so. Only a failed step's
output is printed. With a Dockerfile, a chart and `bun.lock` staged, the hook takes about
five seconds, most of it OSV asking osv.dev.

CodeQL is too heavy for a commit: `bun run codeql` runs it on demand, as the Security
workflow does (the languages and query suite from its CodeQL job, on every file git
tracks or would, as it is on disk), and fails on what the master ruleset blocks a merge
on: a security alert of high severity or above, or an alert of error level, each printed
as `file:line rule message`. `--languages python,actions` limits it to some languages.
It runs natively, with a `codeql` of the pinned version on the PATH or the CodeQL bundle
it downloads once (about a gigabyte) into `~/.cache/boilerplate/codeql`, checked against
its SHA-256; all three languages take a few minutes. The CodeQL CLI's license allows
this on a public repository. A private project made from this template needs GitHub
Advanced Security to run it; without that, remove its use deliberately rather than
looking for a switch to skip it, as there is none.

Before pushing: `bun run lint`, `bun run check-types`, `bun run test`, and for anything
touching the database, queues or HTTP, `bun run test:integration`. The pre-push hook then
runs what CI would (below). The Stop hook stays quick: it checks only the unit coverage
of the lines a turn changed (`bun scripts/unit-coverage.ts`).

## Before a push

The pre-push hook (`.husky/pre-push`, `bun scripts/pre-push.ts`) runs every check CI runs
on a pull request that can run on a developer's machine, so a push that passes it passes
CI. It takes the files the push changes (since the branch's upstream, or the default
branch for a branch never pushed), sorts them into areas with `scripts/changes.ts`, the
same rules CI's `changes` job uses, and runs each step exactly when CI would run its job,
with the job's own commands:

| Step | CI job | Runs for |
|---|---|---|
| `uv sync --locked`, then `bun run gen` and nothing changed or added | setup, codegen | every push; codegen for the app |
| `bun run lint` | lint | every push |
| `bun run check-types`, `bun run type-coverage` | types | the app |
| `bun scripts/push-coverage.ts`: every suite of the affected packages (unit, integration, browser, mobile, Python), the scripts' and hooks', every file under them at 100%, then diff-cover on the changed lines; with Stalwart up (`services.ts up --mail`), the real mail path's suites too | unit, components, integration, python, coverage | the app or the scripts |
| `bun run --cwd packages/ui test:visual` (the screenshots) | components | the app |
| the migrations applied to an empty database, then `bun run --cwd packages/db drift` | integration | the app |
| `uv run python -m evals` in `apps/ai`, with the local stand-ins | python | the app |
| oasdiff (CI's image) on `apps/api` and `apps/ai`'s `openapi.json` against the push's base, and `scripts/events-compat.ts` | api-compat | the app |
| `bun run db:lint` | migrations | the app |
| `bun run charts:check` | charts | the charts |
| `bun run infra:check` (needs `tofu`) | infra | the infrastructure |
| `bun scripts/generators.ts` | generators | the app |
| `bun scripts/e2e.ts --workers=2` with CI's e2e environment and two Playwright workers, as on a CI runner, then the bundle budget and the restore drill | e2e | the app |
| `bun run codeql --languages …` | CodeQL | the languages the push changes |
| `bun scripts/osv.ts`: OSV on `bun.lock` and `apps/ai/uv.lock` | OSV | every push |
| `bun scripts/misconfig.ts`: Trivy's misconfiguration scan, the charts rendered first | misconfig | every push |
| `bun scripts/image-scan.ts`: Trivy on every third-party image the renders, compose and the dev container run | Third-party images | every push |
| the licenses of the npm packages the push adds or upgrades, against `security.yml`'s list | dependency review | a `bun.lock` change |
| gitleaks over the pushed commits | secrets | every push |

CI accepts a breaking API change when the pull request's title declares it (`feat(api)!:`);
here a commit in the push whose header declares one does the same, and the step says so.

Steps that don't depend on each other run side by side, as many as the machine's cores,
less one, and its memory, less 2 GB, hold by each step's rough needs (a build or a test
run takes several cores, a scan one); `PRE_PUSH_CONCURRENCY` (cores, 1 for one step at a
time) and `PRE_PUSH_MEMORY_GB` override them. Docker's free memory decides which steps
that start containers run together. Timing-sensitive browser tests fail on a machine run
far past its cores, which is why the heaviest steps wait for each other. The coverage suites and the generators' check share Valkey's
database numbers, so they take turns. Each step's output is kept and printed when it
fails; the first failure stops the other steps, and the summary names it, with every
step's time. A step can be left out with `PRE_PUSH_SKIP=<step>,<step>` (the summary says
so; CI still runs it).

What needs Docker: the core services, RustFS and Stalwart, which it starts itself (ClamAV comes from
the stand-in in `@repo/testing/fake-clamd` when it isn't running; CI runs the real one), and
the screenshots, whose browser container needs 1.5 GB of Docker's memory free. The
end-to-end step builds and starts the whole stack on its usual ports, so it fails while
`bun dev` runs. Each database step gets a database of its own, dropped afterwards.

A push that changes only documentation or a script takes a minute or two. One that changes
the app runs every suite of what it affects and the end-to-end suite: a push touching
everything took 12 to 16 minutes on a 10-core laptop with turbo's cache warm (the coverage
suites, the end-to-end run and the generators' check are most of it), and longer from a
cold cache. When you need to push now, `git push --no-verify` skips the hook and leaves CI
to decide.

What only CI checks, with the reason, is the `CI_ONLY` list in `scripts/pre-push.ts`,
printed after the summary: the container images and their smoke test (more than a 2 GB
Docker VM holds), the kind deploy (8 GB of Docker memory), the OpenTofu plans and the
nightly drift check (the cloud accounts' secrets), the pull request title (the
commit-msg hook checks every commit's header), the nightly evals against a real model,
the Claude review and the preview environments. The jobs that never run on a pull
request (deploy, SBOM attestation, release, the mobile builds, Renovate, the Stripe
contract check, the uptime probe) are in its `AFTER_MERGE` list. `scripts/pre-push.test.ts`
fails when any workflow gains a job that is in none of these lists, and when a job the
hook mirrors gains a step that its `COUNTERPARTS` table doesn't map to a pre-push step
(or to runner setup).

## Unit

Pure tests: no network, no services, so turbo caches them. Vitest in the TypeScript
packages (the `unit` project in services), Jest with React Native Testing Library in
`apps/mobile`, pytest in `apps/ai`.

## Integration

`bun run test:integration` starts the core services (`bun scripts/services.ts up`) and
runs every package's `test:integration`, never cached, except the file-upload tests.
Those need object storage and virus scanning, and are tagged `files` (vitest's
`{ tags: ["files"] }` on their `describe`, declared by `tags` in `packages/vitest-config`):
`bun run test:integration:files` starts the core plus the files services
(`services.ts up --files`) and runs only them. A package's `test:integration` passes
`--tags-filter=!files` and its `test:integration:files` passes `--tags-filter=files`;
`coverage` passes neither, so `bun run test:coverage` and CI's integration job, which
starts every service, run them all. A new test that needs RustFS or ClamAV gets the tag.
Where ClamAV doesn't fit (a small Docker VM), the worker's suite scans with
`@repo/testing/fake-clamd`, a stand-in that speaks clamd's protocol and finds the EICAR
test file; it's used only when nothing answers at `CLAMAV_URL`, and never in CI.

What each profile needs: the start adds up the memory limits in `docker-compose.yml` of
what isn't running yet, and refuses unless Docker has that free plus half a gigabyte of
headroom.

| Profile | Starts | Limits add up to | Docker needs free |
|---|---|---|---|
| core (`bun run db:up`, `test:integration`) | Postgres, Valkey, Mailpit | 0.9 GB | about 1.4 GB |
| files (`services.ts up --files`, `test:integration:files`) | the core, RustFS, ClamAV | 2.9 GB | about 3.4 GB |
| mail (`bun run db:up:mail`) | the core, Stalwart | 1.2 GB | about 1.7 GB |
| full (`bun run db:up:full`, `test:coverage`, `test:e2e`) | all of the above, Jaeger | 3.4 GB | about 3.9 GB |

Docker Desktop's default 2 GB fits the core; for the others raise it in Settings,
Resources. ClamAV is most of the files profile (1.5 GB). The integration run takes longer
than two minutes, so run it in the background when a tool times out commands (an agent's
shell, for one).

- Each test file gets its own Postgres database cloned from a migrated template, and
  connects as the service's own role, so a missing grant or row-level security policy
  fails here (see [database.md](database.md#test-databases)).
- Each suite uses its own Valkey database number, and 0 is the dev stack's. Valkey has
  32 (the `--databases` flag in `docker-compose.yml`, which CI's integration job runs too).
  Taken: the api's files 1 to 5, 7 to 10 and 13 (one per file, `startApi(<n>)`),
  webhooks 11, nest-common 12, notifications 14, worker 15, webhooks' Stalwart suite 16,
  the api's breached-password suite 17, the web's browser tests 18, jobs 19, the jobs
  CLI's suite 20 (its worker fails every job on a real queue, so it shares with nothing),
  Python 6 and the pre-push hook's end-to-end run 21 (emptied before each run). A new
  suite takes the next free number, 22 onwards;
  `scripts/redis-databases.test.ts` fails when two suites that flush share one. A change
  to the flag needs the local container recreated (`docker compose up -d valkey`).
- Tests never read your `.env`: they run with `.env.example`'s values (the ports docker
  compose publishes), its placeholder secrets replaced by fresh ones and its empty
  values left unset, so they behave the same on every machine and in CI. Anything
  already set in the environment wins, which is how CI points them at its own services
  (`packages/testing/src/environment.ts`, applied by each package's `vitest.config.ts`,
  and `apps/ai/tests/__init__.py` for Python). A test that needs a feature turns it on
  itself.
- Services are built in-process (`createApiServer()` and the like); emails are read
  back from Mailpit, push and Twilio go to local fakes (`apps/notifications/test`), and
  Stripe to `packages/fake-stripe`.
- Nothing sleeps for a fixed time. A test waits for what it's waiting on:
  `eventually(read, done)` from `@repo/testing/eventually`, `vi.waitFor` or
  `expect.poll`. To show that something did not happen, it first waits for a signal that
  the work is over (the job completed, the delivery row written, Redis counting the
  subscriber), then checks once. A delay stays only where it stands in for slow work on
  purpose, with a comment saying so.

A few tests need real third parties and are skipped without them
(`E2E_CIMD_CLIENT_ID`, see [environment.md](environment.md#tests-and-tooling)).

The real mail path runs against the Stalwart container (`bun run db:up:mail`) and is
skipped unless its variables are set (see `.env.example`): with `STALWART_SMTP_URL`,
`apps/notifications/test/stalwart.integration.test.ts` submits through it with the
service's own transport; with `STALWART_URL`, `apps/webhooks/test/stalwart.integration.test.ts`
registers a webhook pointing at itself, sends one message that is delivered (to
Mailpit, DKIM-signed) and one to `bounce.test` that is refused, and checks the signed
`delivery.dsn-perm-fail` Stalwart posts becomes the feedback event that suppresses the
address.

## Web

`apps/web` has two kinds of vitest test, both counted in coverage:

- **Server side** (`src/**/*.test.ts(x)`, the `unit` project, in Node): helpers, the
  proxy, route handlers and route files, and server components. `test/next-server.ts`
  stands in for the request Next.js would be rendering: set `request.cookies` and
  `request.headers`, and next-intl's server functions read them through the real
  `src/i18n/request.ts`. `renderHtml(await Page())` renders a server component,
  async children included. Part of `bun run test`.
- **In the browser** (`test/**/*.test.tsx`, in Chromium through vitest's browser mode):
  pages and components, rendered with `renderPage(<Page />, { url })` from
  `test/render.tsx` inside the app's real providers, and driven like a user with
  `userEvent` and `page` locators from `vitest/browser`. They call the real API: the
  global setup builds apps/api and runs it twice, once with every optional feature on
  (billing against the fake Stripe, files on RustFS, a stand-in for the AI service in
  `test/fake-ai.ts`, Google sign-in) and once with them all off except captcha, where
  Turnstile's script is a stand-in (`test/commands.ts`) and tokens are checked with
  Cloudflare's always-pass test secret. Files named `*.features-off.test.tsx` run against
  the second. The test pages are served on the origin the API knows as `WEB_URL`, and
  `/rpc` and `/api` are proxied to it, so cookies, CORS and passkeys work as on the site.
  Part of `bun run test:integration`.

What a page can't do itself is a command (`commands.<name>()` from `vitest/browser`,
defined in `test/commands.ts`, run in Node): read the code the API queued for an email
(`takeNotification`), set data up with SQL, add a virtual passkey authenticator, compute
an authenticator code. Accounts come from `test/users.ts` (`signUp()` signs a new,
verified user in on the page). Next.js's router exists only inside a Next server, so
`renderPage` provides a stand-in: `router.push` and `<Link>` change the page's URL
(`currentUrl()`), and leaving the page's path unmounts it, as in the app. Full-page
navigations (`window.location.assign`, a redirect to Stripe or Google) are answered
"204 No Content" so the test page stays, and `commands.hardNavigations()` lists them.

Only the API runs, so what the other services would do is done by the test: the
worker's realtime messages (`publishRealtime`), the notification service's in-app rows
(SQL), a Stripe webhook's effect on the subscription (SQL; the fake Stripe's test hooks
make invoices in any status). Uploads go to the real RustFS, sent from Node because its
bucket allows only the dev site's origin (`storageCors`).

Each test starts signed out, with a client IP of its own (the API's auth rate limits
are per IP), and nothing left on screen from the test before it (toasts included).

## Not tested automatically

What CI can't check, and how each is covered instead. A test that needs credentials is
still written, and skips with the reason when they're missing.

| What | Why not in CI | Test, and how to run it |
|---|---|---|
| Google sign-in | needs a real Google account | `apps/web/e2e/google.spec.ts`, with `E2E_GOOGLE_EMAIL` and `E2E_GOOGLE_PASSWORD` |
| Client ID Metadata Documents from a public URL | needs an HTTPS document on the internet | `apps/api/test/oauth.integration.test.ts` (the CIMD case), with `E2E_CIMD_CLIENT_ID` |
| Mail through Stalwart | needs the `mail` profile | `apps/notifications/test/stalwart.integration.test.ts` and `apps/webhooks/test/stalwart.integration.test.ts`, with `STALWART_SMTP_URL` and `STALWART_URL` (above) |
| Native mobile: a session surviving a restart, the push permission prompt, links opened by the OS | needs a device or simulator with a development build | `apps/mobile/maestro/*.yaml`, by hand (`apps/mobile/maestro/README.md`) |
| Real Stripe test mode | the suites use `packages/fake-stripe` | weekly, the calls the api makes against Stripe's test mode and the fake alike (`packages/fake-stripe/src/contract.test.ts`, `stripe.yml`, with `STRIPE_CONTRACT_SECRET_KEY`); hosted Checkout and webhooks by hand: [files-and-billing.md](files-and-billing.md), "Real Stripe test mode" |
| A web push notification being clicked | headless Chromium can't display a notification, so nothing can click one | the service worker's click handling runs in a real browser, through the event a click fires (`apps/web/e2e/service-worker.spec.ts`), and as unit tests (`apps/web/src/service-worker.test.ts`); the operating system showing the notification and delivering the click, by hand: allow notifications on the web app, trigger one, click it |
| Email in real mail clients | rendering differs per client | by hand: the previews (`bun run --cwd packages/email dev`), then a real send |
| Real MCP clients | needs Claude or an IDE on the other end | by hand: connect one to `<site>/api/mcp` and `<site>/ai/mcp` |
| Valkey failing over (`valkey.replication`) | needs nodes to lose; kind has one | the chart's tests render it and the start-up scripts' tests (`scripts/valkey-replication.test.ts`) cover which node follows which; on a three-node cluster, once: delete the primary's pod, and the site keeps working within seconds |
| DNS on a name server of your own (`dns.provider = "rfc2136"`) | needs a real name server and zone | OpenTofu's tests (mocked) and the issuer's chart tests; for real, the first certificate after switching (`kubectl get certificate -A`) and `dig` of the site |
| A preview's address posted by Argo CD | needs the preview cluster and the GitHub App | `scripts/previews.test.ts` reads the trigger and template; for real, label a pull request and wait for the comment |
| The weekly backup drill (`postgres.drill`), and restoring from the offsite copy | needs a cluster with backups; kind has none | `scripts/backup-drill.test.ts` (the script, against a stand-in kubectl) and the chart's tests (which object store the drill restores from); for real, every Sunday in staging, and in production from its offsite copy, or now with `kubectl create job --from=cronjob/<release>-restore-drill` |
| CI's own steps: the image smoke test, the caches, the egress allowlists | need GitHub's runners | `scripts/workflows.test.ts`, actionlint and zizmor (`bun run lint`); for real, the first pull request after a change to them |
| The first real deploy: DNS, TLS, mail deliverability, backups to a new cluster, the SOPS plugin in Argo CD, the first EAS build and store submission, Renovate's and the preview's first runs | needs the real environment | once, per [new-project.md](new-project.md), "The first deploy" |

## Coverage

Every source file is at 100%: lines, branches and functions, in every language. There
are no per-package floors to negotiate: `bun run test:coverage` runs every suite with
coverage and then `bun scripts/coverage.ts`, which merges their reports and fails on any
file below 100%, or one no test loads.

- A source file is any `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs` or `.py` file git tracks,
  wherever it is, except tests and what only they run (`test/`, `tests/`, `e2e/`,
  `maestro/`, `visual/`, `*.test.*`, stories, `jest.setup.ts`), generated code
  (`generated/`, `*.gen.ts`, `*.d.ts`, `en.d.json.ts`) and configs (`*.config.*`,
  `.storybook/`, `.dependency-cruiser.cjs`): `isSource` in `scripts/coverage.ts`. So
  the evals, the web app's service worker, the packages' build scripts and presets, the
  code generators, the load test and the images' checks count like the services, and a
  new folder of code counts the day it lands; `scripts/coverage.test.ts` fails if the
  rule narrows to a list of folders again.
- Every suite writes LCOV: each vitest package (`coverage()` in `packages/vitest-config`
  reports every workspace file its tests load, so a shared package gets credit from the
  apps that exercise it; code only, not an imported JSON file such as the i18n
  messages), mobile's jest (`src/**`), bun (`bunfig.toml`), and the
  Python service and its evals (`fail_under = 100`, branches included, in
  `apps/ai/pyproject.toml`). Bun's runner answers for every source file no other suite
  owns (`BUN_OWNS` in `scripts/coverage.ts`): `scripts/`, `.claude/hooks/`, and the
  tooling outside the services' and packages' `src/`, whose tests are in `scripts/`
  too (`check-peers.test.ts`, `load.test.ts`, `turbo-generators.test.ts`,
  `build-presets.test.ts`, `package-scripts.test.ts`). Its report leaves out the
  services' and packages' `src/` (`coveragePathIgnorePatterns`: a script's test may load
  them, and their own suites cover them) and fails below 100% (`coverageThreshold`);
  `bun scripts/coverage.ts --bun` checks only what it owns, branches too. Mobile's jest
  fails below 100% too. The vitest runs write LCOV
  only: a run's own summary would count every file its tests load from other packages.
- A NestJS package's `vitest.config.ts` also adds `decoratorMetadata()` from
  `packages/vitest-config`: the compiler turns every injected constructor parameter into
  a branch that exists in no source line (a guard for import cycles), and this compiles
  it away so coverage counts only the code that was written.
- The merged report is `coverage/merged.lcov`. CI runs diff-cover on it against the base
  branch at 100%, so a pull request can't add or change a line without covering it, and
  the pre-push hook refuses a push that leaves any file it affects below 100%, then runs
  the same diff-cover check on its changed lines.
- A file may be below 100% only if the table below lists it, with the reason and the
  test that covers its behaviour another way. The same goes for skipped tests (`.skip`,
  `.skipIf`, `.runIf`, `.todo`, `.fixme`, `.fail`, `ctx.skip()`, pytest's `skip` and
  `xfail`), coverage pragmas, type-coverage ignores, and suppressions: `biome-ignore`,
  `@ts-expect-error`, `# pyright: ignore`, `# noqa`, Python's `typing.cast()` (it checks
  nothing), `-- squawk-ignore` in a migration, `# shellcheck disable`,
  `# hadolint ignore`, `# zizmor: ignore`, `# tflint-ignore`, and a rule turned off (or
  down to a warning) in `biome.jsonc` or another linter's configuration.
  `bun scripts/suppressions.ts`, part of `bun run lint`, fails on any that no row
  allows, and a Claude Code hook refuses a new one as it's written. A row allows one
  kind in one file: a skipped test needs its file under Skipped tests, a coverage
  pragma under Coverage exceptions, a type-coverage ignore under Type-coverage
  exceptions, and a suppression a row under Suppressions that names it (a rule turned
  off is named by the rule). A focused test (`.only`) is never allowed. Listing a file
  here is a decision for review, never a way round.

## Coverage exceptions

| File | Why it can't be covered | What proves it instead |
|---|---|---|

## Skipped tests

| File | Skipped when | Where it runs |
|---|---|---|
| `apps/api/test/oauth.integration.test.ts` | `E2E_CIMD_CLIENT_ID` is unset: the client metadata document must be served over public HTTPS | by hand, against a deployed environment |
| `apps/notifications/test/stalwart.integration.test.ts` | `STALWART_SMTP_URL` is unset: Stalwart isn't in the default profile | CI's integration job, with the `mail` profile |
| `apps/webhooks/test/stalwart.integration.test.ts` | `STALWART_URL` is unset, as above | CI's integration job, with the `mail` profile |
| `apps/web/e2e/captcha.spec.ts` | the API has no Turnstile keys (`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`), so the captcha is off | CI's e2e job, with Cloudflare's always-pass test keys: the real widget and token flow, reaching challenges.cloudflare.com; a real site's keys only by hand |
| `apps/web/e2e/google.spec.ts` | `E2E_GOOGLE_EMAIL` and `E2E_GOOGLE_PASSWORD` are unset | by hand, with a test Google account |

## Suppressions

| File | Suppression | Why |
|---|---|---|
| `apps/web/src/lib/cookies.ts` | `biome-ignore lint/suspicious/noDocumentCookie` | the Cookie Store API isn't in every browser yet |
| `packages/ui/src/components/field.tsx` | `biome-ignore lint/a11y/useSemanticElements` | `Field` is a `div` with the group role: a fieldset brings its own border, padding and minimum width into every form row (`FieldSet` is the fieldset, for a group of fields) |
| `packages/ui/src/components/input-otp.tsx` | `biome-ignore lint/a11y/useSemanticElements` | the separator holds an icon, which an `hr` can't |
| `packages/ui/src/components/label.tsx` | `biome-ignore lint/a11y/noLabelWithoutControl` | `Label` is a wrapper: the caller ties it to its control (`htmlFor`, or the control inside it) through props the rule can't see |
| `scripts/restore-drill.ts` | `biome-ignore lint/suspicious/noUndeclaredEnvVars` | the rule asks turbo.json to declare what a task reads, and turbo never runs this script |
| `.claude/hooks/lib.ts` | `biome-ignore lint/suspicious/noUndeclaredEnvVars` | Claude Code sets `CLAUDE_PROJECT_DIR` for its hooks, which turbo never runs |
| `.claude/hooks/session-start.ts` | `biome-ignore lint/suspicious/noUndeclaredEnvVars` | Claude Code sets `CLAUDE_ENV_FILE` for its session-start hook, which turbo never runs |
| `.github/workflows/deploy.yml` | `# zizmor: ignore[dangerous-triggers]` | `workflow_run` is how a deploy follows CI on master; the job that checks out the run's commit runs only for this repository's own push (`scripts/workflows.test.ts` checks) |
| `.github/workflows/mobile.yml` | `# zizmor: ignore[dangerous-triggers]` | the same, for the app updates that follow CI and the store builds that follow a release |
| `.devcontainer/Dockerfile` | `# hadolint ignore=DL3066` | `USER node` by name, not its id: the dev container features the image takes (docker-in-docker, for one) find the user to set up by its name |
| `.github/zizmor.yml` | `self-repository` off | GitHub's `uses: $/...` syntax for this repository's own actions, which actionlint (in the same lint job) doesn't read yet |
| `biome.jsonc` | `noExcessiveLinesPerFunction` off in tests, end-to-end specs and stories | a `describe` block is as long as its list of cases |
| `biome.jsonc` | `noSkippedTests` off in `apps/web/e2e/captcha.spec.ts` and `apps/web/e2e/google.spec.ts` | Playwright's conditional skip, for the two browser tests that need real credentials (both under Skipped tests) |
| `biome.jsonc` | `noDuplicateCustomProperties` off in `packages/ui/src/styles/theme.css` | the theme sets each variable once per variant (light, dark), and Biome reads the blocks as one rule |
| `biome.jsonc` | `useImportType` and `noStaticOnlyClass` off in the Nest services and `packages/nest-common` | Nest's dependency injection needs the imported class at run time, which `import type` erases; a module is a class with only a decorator and static members |
| `biome.jsonc` | `noConsole` off in `scripts/`, the hooks, config files and the API's command-line scripts | they talk to whoever runs them through the console |
| `apps/ai/app/embeddings.py` | `# noqa: SIM905` | a stop-word list reads as prose on one line |
| `apps/ai/app/documents.py` | `# pyright: ignore[reportMissingTypeStubs]` | langgraph ships no stubs |
| `apps/ai/app/summaries.py` | `# pyright: ignore[reportMissingTypeStubs, reportUnknownMemberType]` | langgraph ships no stubs, and its graph, config and checkpointer types are unknown |
| `apps/ai/app/queues.py` | `# pyright: ignore[reportMissingTypeStubs, reportUnknownMemberType, reportArgumentType]` | bullmq ships no stubs and leaves job data untyped |
| `apps/ai/app/main.py` | `# pyright: ignore[reportUnknownMemberType]` | redis-py's options are untyped |
| `apps/ai/app/worker.py` | `# pyright: ignore[reportUnknownMemberType]` | redis-py's options are untyped |
| `apps/ai/app/realtime.py` | `# pyright: ignore[reportUnknownMemberType]` | redis-py's options are untyped |
| `apps/ai/app/settings.py` | `# pyright: ignore[reportCallIssue]` | pydantic-settings fills the fields from the environment |
| `apps/ai/app/log.py` | `typing.cast()` | structlog's `get_logger()` is typed `Any` and hands back a lazy proxy that takes its class from `configure_logging`, which runs later; there is nothing to check at import, and checking the proxy would bind it before it's configured |
| `apps/ai/app/telemetry.py` | `# pyright: ignore[reportUnknownMemberType]` | the Redis instrumentor's `instrument()` is untyped |
| `apps/ai/evals/__main__.py` | `# pyright: ignore[reportAssignmentType]` | pydantic-evals' report type is wider than what it returns |
| `apps/ai/tests/conftest.py` | `# pyright: ignore[reportUnknownMemberType]` | redis-py's options are untyped |
| `apps/ai/tests/support.py` | `# pyright: ignore[reportUnknownMemberType]` | redis-py's options and handlers are untyped |
| `apps/ai/tests/test_evals.py` | `# pyright: ignore[reportArgumentType]` | these checks never read spans, so none are passed |

## Type-coverage exceptions

`bun run type-coverage` counts every type assertion and non-null `!` as well as every
`any`. A line it may skip (`// type-coverage:ignore-next-line` above it) is one where
TypeScript can't express a type the code already guarantees, and no parse, guard or
better-typed call can say it instead.

| File | Line | Why |
|---|---|---|
| `packages/i18n/src/index.ts` | `bundledMessages`' `catalogs[locale] as Messages` | a translation has English's keys and arguments in other words, and TypeScript can only read a message's arguments from English's literal text; the ICU test checks every catalog's arguments against English |
| `packages/i18n/src/index.ts` | `loosely`'s `t as LooseTranslate` | a key known only at run time can't be paired with its arguments at compile time; the ICU test checks them instead |
| `packages/db/src/tenancy.ts` | `asTx`'s `tx as Tx` | `Tx` is a brand only the transaction helpers may give a client, so there is nothing to check at run time |
| `packages/nest-common/src/env.ts` | `forService`'s `Object.fromEntries(...) as {...}` | TypeScript can't type an object whose keys are built from a generic string (`${service}_DATABASE_URL`), and each service's env schema needs its own names typed |
| `apps/mobile/src/components/ui/text.tsx` | `webRole`'s `role as Role` | react-native's `Role` leaves out the roles only react-native-web renders (`blockquote`, `code`), which the web build needs |
| `packages/contracts/src/api/base.ts` | `errorsOf`'s `Object.fromEntries(...) as {...}` | TypeScript can't type an object built from a list of keys, and oRPC clients need each code's own entry to type its error |

## End to end

`bun run test:e2e` (`scripts/e2e.ts`) tests exactly what it just built:

1. builds api, worker, notifications, webhooks and web for production, and the mobile
   app for the web;
2. starts the fake Stripe, those services, the AI service and its worker, the web app and
   the mobile web build, all with `NODE_ENV=test` (production refuses the local stand-ins
   the suite uses), logging to `logs/`;
3. runs the web Playwright suite, the mobile one, then the k6 smoke and the
   [fuzzing](#fuzzing);
4. stops everything.

Everything listens on this checkout's ports (its `.env`'s `*_PORT`, else
`.env.example`'s), so a checkout with its own stack (`bun run setup --stack <n>`,
[environment.md](environment.md#local-service-ports)) runs its suite while another runs
theirs. It refuses to start while something already listens on those ports, so an old
server can't answer instead.

When the API has Turnstile on (CI sets Cloudflare's always-pass test keys), the web
suite's pages get the same stand-in widget as the browser tests (`test/turnstile.ts`),
so a sign-up never waits on Cloudflare's real widget, which can hang on a CI runner.
`captcha.spec.ts` alone loads the real one (`test.use({ realTurnstile: true })`).

In CI a failed test is retried up to twice, to tell a flaky one from a broken one, but a
test that only passed on a retry still fails the run (`failOnFlakyTests`): fix it rather
than rerunning the job.

```sh
bun run test:e2e                                    # everything
bun run test:e2e --app web e2e/assistant.spec.ts    # one app; the rest goes to Playwright
bun run test:e2e --app mobile                       # the mobile screens, rendered for the web
bun run test:e2e --app load                         # the k6 smoke on its own
bun run test:e2e --app fuzz                         # the fuzzing on its own
bun run --cwd apps/web test:e2e                     # against a stack you're already running (bun dev)
```

`apps/web/e2e/google.spec.ts` runs only with `E2E_GOOGLE_EMAIL` and `E2E_GOOGLE_PASSWORD`.
CI runs the suite with the captcha on, with Cloudflare's always-pass test keys (in
`ci.yml`'s e2e job), so the widget and the token check run too; locally
`apps/web/e2e/captcha.spec.ts` skips unless you set them (`.env.example`).

## Mobile

- `bun run --cwd apps/mobile test`: Jest. Screen tests (`src/screens-tests/`) open the
  whole app at a URL with `openApp` (`test/app.ts`, on expo-router's `renderRouter`), so
  routing, the protected routes and the real auth and API clients all run. The network is
  faked at `fetch` with `fakeApi` (`test/fake-api.ts`), which answers each path the way
  the API does; only native modules without a JavaScript stand-in (secure storage, push,
  the passkey prompt, the build's manifest) are mocked, in `jest.setup.ts`.
- `bun run test:e2e --app mobile`: the app's screens rendered with react-native-web and
  driven by Playwright (`apps/mobile/e2e`), against the API on the mobile web build's own
  origin. With the captcha on (CI's test keys), sign-up and resending a code open the web
  app's captcha page in a popup, which passes and closes by itself. Passkeys go through
  Chrome's virtual authenticator (`addPasskeyAuthenticator` in `e2e/support.ts`).
- Maestro flows for what only a native build can check, run by hand
  (`apps/mobile/maestro/README.md`).

## API client

`packages/client`'s hooks are unit tests against the API's contract implemented in
memory (`packages/client/test/stand-in.tsx`): `standIn` takes the procedures a test
calls, typed by the contract, and answers over oRPC's own wire format through the
client's `fetch` option, so inputs and outputs are validated both ways as against the
real API. `renderHook` renders a hook inside `ApiProvider` with `react-test-renderer`.
Polling and reconnect waits run on fake timers (`setInterval` for polling, `setTimeout`
for reconnects and retries), advanced to the millisecond, with `until` to wait for a
condition without moving them. The API's own behaviour is covered by its tests in
`apps/api`.

## Components

`bun run --cwd packages/ui test:stories` runs every story in Chromium, in the light and
dark themes: it must render, pass its play function and have no axe violations. The same
run includes the package's plain browser tests (`src/components/<name>.test.tsx`,
rendered with `render` from `packages/ui/test/render.tsx`) for what a story doesn't show:
a part no story uses, an edge case. They take no screenshots, so they need no baselines.
`bun run --cwd packages/ui test:visual` compares a screenshot of every story and theme
with the committed baselines, in the Playwright Docker image;
`test:visual:update` rewrites them. The image's tag must be the installed Playwright's
version, and `scripts/pins.test.ts` fails when it isn't: the baselines depend on that
exact browser build.

## Load

```sh
bun run test:load                                # smoke: a few requests a second for 30 s
PROFILE=load bun run test:load                   # ramps to TARGET_RPS (default 200) and holds it
PROFILE=load DURATION=30m bun run test:load      # soak
```

It signs in `LOAD_USERS` users first through the API's own auth
(`bun run --cwd apps/api load:users`, sessions in `load/.sessions.json`, since sign-in is
rate limited per IP), then runs k6 in Docker against `BASE_URL` (default the API's port on the host,
`http://host.docker.internal:<API_PORT>`). The traffic is signed-in users reading and changing
todos over `/api/v1`, which exercises the session, membership, row-level security,
optimistic versions and the outbox. The thresholds in `load/api.ts` are the latency and
error budget; the run fails when one does.

## Fuzzing

`bun run test:fuzz` (`scripts/fuzz.ts`) runs [Schemathesis](https://schemathesis.readthedocs.io)
against the API and the AI service, from their OpenAPI documents: for every operation it
sends requests generated from the schema, valid ones and invalid ones, and fails on a
server error, or on a response whose status, content type or body the document doesn't
declare. So the document has to say what the API really answers, and the API has to
answer every request it can't serve with a declared 4xx. uvx runs the pinned version
locally; nothing leaves the machine.

```sh
bun run test:fuzz                # against the stack you run: bun dev, and bun run --cwd apps/ai dev
bun run test:e2e --app fuzz      # builds and starts the stack itself, then fuzzes it
```

- `schemathesis.toml` holds the checks, a fixed seed and at most 50 generated examples
  per operation, so a run sends the same requests every time and takes a minute or two.
  A failure prints the request as a `curl` command to reproduce it.
- Each API operation is fuzzed on its own, as a signed-in user of its own (apps/api's
  `load:users`): most writes share one per-user rate limit, which would otherwise answer
  429 to nearly everything after the first few operations. Limits counted per hour (file
  uploads, documents, phone codes) still answer 429 once spent, which the document
  declares. The users are on the Free plan, so the webhook operations mostly answer 402.
- The AI service is called the way the API calls it, with a short-lived token signed
  with `AI_SERVICE_SECRET` for the first of those users.
- What the API does on purpose that Schemathesis can't read is configured in
  `schemathesis.toml`, each with a comment saying why: the assistant's answer streams
  server-sent events whose data oRPC documents decoded, so its schema check is off. The
  realtime stream never ends, so `scripts/fuzz.ts` leaves it out.

CI runs it in the end-to-end job, on the second shard, against the stack that job
already built and started.

## Python

`bun run test` and `bun run test:integration` include `apps/ai`. The integration tests run
the worker as a subprocess and check the SQLAlchemy models against the migrated database.
The evals run on every change with the local stand-ins; see
[python-services.md](python-services.md#evals).

## Static checks

| Command | What it checks |
|---|---|
| `bun run lint` | Biome, `lint:boundaries` (dependency-cruiser, the web render-only check and `scripts/check-layers.ts`), `lint:unused`, `lint:markers`, `lint:patterns`, `lint:suppressions`, `lint:prisma`, the linters below, and each package's `lint` (ruff and deptry for Python), all of them even when one fails, with a summary at the end (`scripts/lint.ts`); CI runs the same command |
| `bun run lint:prisma` | the Prisma schema is as `prisma format` writes it (`--check`): the pre-commit hook formats it, and this catches a commit made without the hook |
| `bun run lint:actionlint`, `lint:zizmor` | the workflows: actionlint (with shellcheck on every `run:` block) and zizmor's security audits, offline, with `.github/zizmor.yml`. Each at the version `scripts/linters.ts` pins: a local binary of it, else its image in Docker |
| `bun run lint:shellcheck` | every shell script: `*.sh`, the git hooks in `.husky/`, and any file whose first line runs a shell. A `.shellcheckrc` says which shell for the scripts that have no first line saying so (the hooks and the data chart's scripts, all run with `sh`) |
| `bun run lint:hadolint` | every Dockerfile (`deploy/docker/`, `.devcontainer/Dockerfile`) |
| `bun run lint:tflint` | the OpenTofu modules and environment, with every rule of the Terraform ruleset bundled with tflint (`infra/tofu/.tflint.hcl`) |
| `bun run lint:renovate` | `renovate.json5`, with Renovate's config validator in strict mode, so a broken or outdated setting fails here instead of Renovate quietly stopping. It also refuses any other config file Renovate would read first (`renovate.json`, `.renovaterc*`, `.github/renovate.json5` and the like), tracked or not, since a stray copy would quietly replace the real one. The version is the one `renovate.yml` runs Renovate at, read from that workflow: a local `renovate-config-validator` of it, else the `renovate/renovate` image in Docker (a large pull, once; about two seconds after that) |
| `bun run lint:unused` | knip (`knip.jsonc`): unused files, exports and dependencies, and dependencies used but not declared |
| `bun run lint:markers` | no `ponytail:` markers in tracked source (`scripts/check-markers.ts`): a comment says why in plain words |
| `bun run lint:patterns` | code shapes Biome can't see (`scripts/check-patterns.ts`): in services' and packages' `src/`, `scripts/`, `load/` and `turbo/generators/`, parsed JSON cast to a type, a type argument on `$queryRaw`, an optional chain three deep, a role compared with `"member"`, an error sent without `sendError`; in tests, a fixed sleep outside a polling loop |
| `bun run check-types` | tsc everywhere, basedpyright (strict) for Python |
| `bun run db:lint` | Squawk on new migrations |
| `bun run --cwd apps/web budget` | first-load JavaScript per route, after `next build` |
| `bun run charts:check` | the Helm charts: lint, unit tests, every environment rendered and validated |
| `bun run infra:check` | OpenTofu fmt, validate and module tests (mocked providers) |

## What CI runs

On every pull request, push to `master` and merge group (`.github/workflows/ci.yml`).
Branch protection requires **CI passed**, which succeeds only when all of these do. On a
pull request, the first job (`scripts/changes.ts`) says which areas it touches (the app,
the charts, OpenTofu, the Dockerfiles, the scripts), and a job for an area it doesn't
touch is skipped: a docs-only change runs lint, the title check and the scripts' tests
(some read docs by name, and the rename test reads every tracked file), and a change to
`deploy/` only the charts and the scripts' tests. **CI passed** accepts a skip only
for those areas.

| Job | Runs |
|---|---|
| Lint and boundaries | `bun run lint` (Biome, boundaries, knip, markers, suppressions, the linters of the workflows, shell scripts, Dockerfiles, OpenTofu and Renovate's config, each package's lint) |
| Type-check | `bun run check-types`, then `bun run type-coverage` (strict: no `any`, type assertion or non-null `!` in any workspace's source, the repo's scripts, the load test or the code generators, but the Type-coverage exceptions) |
| Unit tests | `bun run test` |
| Components | the stories with coverage, `test:visual` |
| Integration tests | migrations, the drift check, then every package's `coverage` except Python's and the stories', and the scripts' and hooks' |
| End-to-end tests | `bun run test:e2e` (the fuzzing on the second shard), the bundle budget, the restore drill |
| Python service | ruff, basedpyright, pytest, the evals with stand-ins, then every test with coverage |
| Coverage | the reports of the three jobs above merged: `bun scripts/coverage.ts`, then diff-cover at 100% against the base branch (pull requests) |
| Generated code is committed | `bun run gen`, then no diff |
| API compatibility | oasdiff against the base branch's `apps/api/openapi.json` and `apps/ai/openapi.json`, and the event catalog's compatibility (pull requests) |
| Pull request title | Conventional Commits with an allowed scope (pull requests) |
| Migration safety | `bun run db:lint` |
| Helm charts and GitOps | `bun run charts:check` |
| OpenTofu | `bun run infra:check` |
| Container images | every image builds, Trivy finds no fixable critical or high vulnerability, and each one starts against Postgres and Valkey and answers (`scripts/image-smoke.ts`: the dependencies check, an RPC, a page; the migrate image migrates an empty database) |

Elsewhere: `kind.yml` deploys the stack to a kind cluster, waits for KEDA to read the
worker's queues from Valkey, and smoke-tests the routes (`bun run k8s:up`) when the images, charts or migrations change; `security.yml` runs
CodeQL, a secret scan of the history, dependency review, OSV and a Trivy scan of the
infrastructure configuration (`trivy.yaml`: any finding fails unless `.trivyignore.yaml`
records why it doesn't apply; `bun scripts/misconfig.ts` runs the same scan locally).
`bun scripts/image-scan.ts` scans every third-party image the rendered manifests run
(our charts, the platform's, the add-ons' and Argo CD's, as `scripts/misconfig.ts`
renders them, including images an operator is told to start), and those deploy/ and
compose name, each at its digest (a tag resolved first; read from its registry, never
pulled into Docker; a digest that passed today isn't scanned again), and the dev
container as it builds, for fixable critical or high vulnerabilities, as CI's Container
images jobs scan ours; `bun scripts/image-scan.ts <ref>` scans one. A vulnerability no
upstream image fixes yet goes in that image's file under `.trivyignores/` (named after
its repository), with the package, why, and an expiry about a month out; when it passes,
the scan fails until the image moves to a fixed release.

## Nightly and weekly

| When (UTC) | What |
|---|---|
| 02:43 daily | `kind.yml`: the kind deploy and smoke test |
| 03:23 daily | `ci.yml` on `master`, with the load test at `PROFILE=load` (`LOAD_TARGET_RPS`, default 50) instead of the smoke, and the evals against `EVAL_MODEL` when that variable is set |
| 04:30 daily | Renovate |
| 04:17 Mondays | `security.yml`, for vulnerabilities published against unchanged code |
| 05:41 Wednesdays | `stripe.yml`: the fake Stripe's contract against Stripe's test mode, when `STRIPE_CONTRACT_SECRET_KEY` is set |
