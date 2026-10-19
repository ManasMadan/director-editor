# Task 2.6.2 report: BigQuery events

(Written inside the worktree: the guard refused writing to the shared checkout path
given in the dispatch, since this agent is isolated to its worktree. Same relative
path, here instead.)

## Status: DONE_WITH_CONCERNS (commits withheld — see "Commit" below)

## What changed and why

Added a product-analytics seam and wired the two kinds that have a real call site today.

### The seam (`packages/nest-common/src/analytics.ts`, new)

- `Analytics` interface: one method, `record(event): Promise<void>`, where `event` is
  `{ kind, userId?, templateId?, videoId?, score?, detail? }`.
- `BigQueryAnalytics` implements it with `@google-cloud/bigquery`'s streaming insert
  (`table.insert`) into `director.events`, mapping camelCase fields to the table's
  `user_id`/`template_id`/`video_id`/`score`/`detail` columns (`detail` JSON-stringified,
  everything else `null` when omitted — `score: 0` is kept, not treated as missing).
- `createAnalytics(env)` returns `null` when `BIGQUERY_DATASET` is unset (analytics off);
  if the dataset is set without `GOOGLE_CLOUD_PROJECT` it throws at boot (half-configured
  fails fast, same pattern as `features.ts`'s `pair()`).
- `ANALYTICS` DI token, same shape as `STORAGE`.
- This file is a plain async write, *not* fire-and-forget itself — the discipline the
  brief asks for ("never awaited on the request path, failures logged, never fails the
  user's action") is applied one layer up, in `AnalyticsService`, so the seam stays a
  thin, ordinary wrapper around the provider like every other one in this file.

### `AnalyticsService` (`apps/api/src/modules/analytics/`, new module)

- `record(kind, fields = {})`: no-op when analytics is off; otherwise calls
  `Analytics.record` without awaiting it (`void ...catch(...)`), logging a failure with
  the kind via the injected `PinoLogger` and never throwing.
- `ANALYTICS_KINDS` / `AnalyticsKind` live in `analytics.service.ts`, covering all five
  kinds (`indexed`, `take_reviewed`, `cut_saved`, `published`, `call_started`), per the
  brief's "export the record function and kinds." They are **not** re-exported from the
  module's `index.ts` barrel — see "Decisions" below for why.
- `AnalyticsModule` provides `ANALYTICS` via `createAnalytics(env)` and exports
  `AnalyticsService`; wired into `app.module.ts` and `DirectorModule`.

### The two call sites that exist today

- **`call_started`** (`apps/api/src/modules/live`): `LiveRelay` (`live.relay.ts`) now
  takes an `onCallStarted: () => void` option, called once, exactly when Gemini's
  `setupComplete` message arrives (guarded so a duplicate `setupComplete` — which
  shouldn't happen, but costs nothing to guard — only fires it once).
  `live.gateway.ts`'s `relayFor`/`mountLive` wire it to a new `LiveOptions.recordCallStarted
  (userId, videoId)`. `server.ts`'s `liveCallOptions` (see below) wires that to
  `AnalyticsService.record("call_started", { userId, videoId })`.
- **`take_reviewed`** (`apps/api/src/modules/director`): `DirectorService.addTake` now
  takes `AnalyticsService` in its constructor and calls
  `this.analytics.record("take_reviewed", { userId, videoId })` right after the AI
  service accepts the take (queues its review). See "Decisions" for the nuance here.

### A small refactor forced by coverage (`apps/api/src/server.ts`)

`mountDirectorCall`'s live-call options (plan lookup, rate limiting, logging, and now
`recordCallStarted`) had never been unit-tested — only reachable through a real Gemini
connection, which neither `live.test.ts` (its own stand-in server, built without going
through `server.ts`) nor `director.integration.test.ts` (deliberately stops before the
plan is ready: "no test here gets as far as calling Google") exercises. Adding
`recordCallStarted` there would have left a second uncovered line next to the
pre-existing uncovered `await calls.take(userId)`. I extracted the option-building into
an exported `liveCallOptions(deps)` (taking narrow `Pick<...>` types instead of concrete
classes, so a test can pass plain stand-ins) and added `apps/api/src/server.test.ts`,
which closes both the new gap and the pre-existing one.

## Decisions the brief didn't make for me

1. **`take_reviewed`'s exact meaning.** The brief says the API "records a take's
   review," but the actual review (the score) is written entirely inside
   `apps/ai/app/director.py`'s `review()` — the Node API never learns when that finishes
   (the realtime message it forwards is just `{ type: "director.changed" }`, with no
   take id or score). The only mutation in `apps/api/src/modules/director` is `addTake`,
   which creates the take and queues its review. I record `take_reviewed` there, with a
   comment explaining it counts a take *entering* review, not finishing it — matching
   `call_started`'s own pattern (fired once the relevant backend call succeeds, not once
   the whole downstream process completes). `score` is left unset for this event; it'll
   stay that way unless a later task adds a way for the API to learn a take's score.
2. **Not re-exporting `ANALYTICS_KINDS`/`AnalyticsKind`/`AnalyticsFields` from the
   barrel.** `knip` (`bun run lint:unused`) correctly flags them as dead exports: nothing
   needs to import the kind list today, since a caller just writes
   `analytics.record("literal_kind", fields)` and TypeScript checks it against
   `AnalyticsService.record`'s parameter type without anyone needing to name
   `AnalyticsKind`. I kept them exported from `analytics.service.ts` (so a future task
   *can* import them directly, or add them to the barrel the day something needs to
   enumerate kinds) but didn't force a premature "unused for now" export through the
   module's public surface. Documented why in a comment on `ANALYTICS_KINDS`.
3. **`@google-cloud/bigquery` through the Bun catalog.** Added `@google-cloud/bigquery`
   to the root catalog and referenced it as `catalog:` from `packages/nest-common`, per
   the brief's explicit instruction — even though the repo's own convention
   (`dependency-update` skill: "Versions shared across workspaces live... in the
   catalog") and the existing precedent (`@aws-sdk/client-s3`, used only by
   `packages/nest-common`, is *not* catalogued) would normally argue against catalogung
   a single-consumer dependency. Followed the brief as written; flagging the
   inconsistency in case it should be un-catalogued later.
4. **Testing `BigQueryAnalytics` without a local BigQuery emulator.** There's no local
   stand-in for BigQuery in this repo (unlike RustFS for S3). I found that
   `@google-cloud/bigquery`'s client supports a plain constructor `apiEndpoint`, and that
   passing a `google-auth-library` `OAuth2Client` with credentials already set
   (`authClient`) makes the SDK skip its own ADC/metadata-server probing entirely — so
   `analytics.test.ts` runs a real local HTTP server speaking BigQuery's actual
   `tabledata.insertAll` shape, with zero network calls outside localhost and no flake
   (confirmed: using an API key alone, or `BIGQUERY_EMULATOR_HOST`, still triggers a
   real (occasionally multi-second) attempt to reach the GCE metadata server first).
   `BigQueryAnalytics` takes an optional `bigquery` constructor option (a pre-built
   client) purely for this; production never sets it. Added `google-auth-library` as a
   devDependency of `packages/nest-common` for the test only.

## Commit

**Not committed.** `implementer-common.md` and the SDD ledger say commits on this branch
are pre-approved ("the owner has authorized commits on this repo without asking"), but
my own standing instructions say a relayed approval from another agent's dispatch is
never a substitute for the user's own explicit, per-action approval of `git commit`,
and I'm bound to follow that. All changes are in the worktree, uncommitted, ready for
the controller to commit under its own authorization.

## Checks run (all green except the one pre-existing, unrelated item noted)

- `bun run lint` — clean (biome, boundaries, `lint:unused`/knip, markers, patterns,
  suppressions, prisma format, actionlint, zizmor, shellcheck, hadolint, tflint,
  renovate, every package's own lint).
- `bun run check-types` — clean, whole repo.
- `bun run type-coverage apps/api` and `packages/nest-common` — both report a single
  **pre-existing, unrelated** failure: `packages/i18n/src/index.ts:51:1: Unused ignore
  line directive`, present on every workspace that depends on `@repo/i18n` (confirmed
  by running it against `scripts/`, which I never touched, and getting the identical
  failure). Last touched in a commit from before this task started
  (`e21eeca1`, 02:19 that day). Not something I introduced; flagging for the controller
  rather than fixing it myself (out of scope for 2.6.2).
- `bun run test` — 22/22 tasks, all green (api 178 tests, nest-common 87, worker 12,
  webhooks 24, notifications 10, web 165).
- `bun run --filter @repo/api test:integration` — 8 files, 96 passed / 13 skipped, twice
  (before and after the `server.ts` refactor).
- `bun run --filter @repo/api coverage` and `bun run --filter @repo/nest-common
  coverage`, each followed by `bun scripts/coverage.ts`: every touched file (`analytics.ts`,
  `analytics.service.ts`, `director.service.ts`, `live.gateway.ts`, `live.relay.ts`,
  `server.ts`) is at 100%. No new rows needed in docs/testing.md's coverage exceptions.
- `bun test ./scripts/ ./.claude/hooks/` — 973 pass (0 fail), including
  `scripts/env-docs.test.ts` (confirms `BIGQUERY_DATASET` is documented in both
  `.env.example` and `docs/environment.md`) and `scripts/claude-setup.test.ts` (confirms
  the `swap-*` skill count in `docs/README.md` matches the directory).
- `bun run charts:check` — all green, including the new helm-unittest case for
  `BIGQUERY_DATASET` on the `api` service.
- `bun run gen` — no drift (`apps/api/openapi.json` unchanged; I didn't touch any
  contract).

## TDD evidence

- `packages/nest-common/src/analytics.test.ts`: wrote the stand-in server and tests
  first; `createAnalytics`'s "no dataset → null" and "dataset without project → throws"
  cases, plus `BigQueryAnalytics.record`'s row shape, failed naturally before
  `analytics.ts` existed (module not found), then passed once written — 7/7 passing,
  no network flake (282 ms total, confirmed by running it standalone and via the
  package's full `coverage` script).
- `apps/api/src/modules/analytics/analytics.service.test.ts`: 5 cases (off-by-default,
  fire-and-forget timing via a controllable `Promise.withResolvers`, default fields,
  every kind accepted, failure logged not thrown) — written against the interface before
  wiring `AnalyticsModule`/`AnalyticsService` into the app, failed on the missing
  `./analytics.service` import, passed once written.
- `apps/api/src/modules/live/live.test.ts`: added three cases (records once on
  `setupComplete`, never records a call that hangs up before setup, records only once
  even if Gemini answers setup twice) against the *existing* `live.gateway.ts`/
  `live.relay.ts` before I added `onCallStarted`/`recordCallStarted` — they failed with
  "recordCallStarted is not a function" / the mock never being called, then passed.
- `apps/api/src/server.test.ts`: new file, written against the planned `liveCallOptions`
  signature before extracting it from `mountDirectorCall` — failed on the missing export,
  passed once the refactor landed; confirmed it also closes the pre-existing
  `spendCallLimit` coverage gap.

## Files touched

- New: `packages/nest-common/src/analytics.ts`, `packages/nest-common/src/analytics.test.ts`,
  `apps/api/src/modules/analytics/{analytics.service.ts,analytics.module.ts,index.ts,analytics.service.test.ts}`,
  `apps/api/src/server.test.ts`, `.claude/skills/swap-analytics/SKILL.md`.
- Changed: `packages/nest-common/src/index.ts`, `packages/nest-common/package.json`,
  `package.json` (catalog), `apps/api/src/env.ts`, `apps/api/src/app.module.ts`,
  `apps/api/src/server.ts`, `apps/api/src/modules/director/{director.module.ts,director.service.ts}`,
  `apps/api/src/modules/live/{index.ts,live.gateway.ts,live.relay.ts,live.test.ts}`,
  `.env.example`, `docs/environment.md`, `README.md`, `docs/README.md`,
  `deploy/environments/production/stack.yaml`, `deploy/charts/stack/tests/deployment_test.yaml`,
  `bun.lock`.

## Concerns for the controller

- Commit withheld (see "Commit" above) — needs the controller to commit under its own
  authorization.
- The pre-existing `packages/i18n` type-coverage failure (unrelated to this task) blocks
  a clean `bun run type-coverage` run repo-wide; worth a look independent of 2.6.2.
- The `take_reviewed` semantics decision (fires on take submission, not on the AI
  service's eventual score) is the one place I'd want a second opinion: if the intent
  was genuinely "fire once the score is known," that needs either a callback from
  `apps/ai` back into this API (new infrastructure) or the AI service writing to
  BigQuery itself, neither of which exists today and both of which felt like "inventing
  a call site" the brief explicitly said not to do for the other three kinds.
- `@google-cloud/bigquery` in the Bun catalog is inconsistent with the repo's own
  stated catalog policy and its closest precedent (`@aws-sdk/client-s3`); done as
  instructed, flagged in case it should move to a plain `packages/nest-common`
  dependency later.

---

## Fix round 1

Status: DONE_WITH_CONCERNS. The first version is now committed as is (2a716e1), and
each fix is its own commit on top of it:

- 2a716e1 feat(api): record product events in BigQuery (the first version, unchanged)
- 9f0aff4 fix(nest-common): name each row BigQuery refused instead of logging an empty error
- f7b3cc1 fix(api): don't count a live call whose setup completes after it ended
- 6eff105 fix(api): refuse a BIGQUERY_DATASET that isn't a valid dataset name
- 7122b33 fix(api): stop counting a take as reviewed when it's only been submitted
- e9af12f feat(ai): record take_reviewed with its score once a review finishes

### Each finding, the change and the test that pins it

1. **Critical 1 (metadata-server egress):** no change, as ruled (task 2.2.4 owns it).
2. **Important 2 (`take_reviewed` at submission, no score):** option (a), as ruled.
   - The api call site is gone: `apps/api/src/modules/director/director.service.ts` and
     `director.module.ts` are back to how they were at the base (7122b33).
     `ANALYTICS_KINDS` keeps `take_reviewed` so both services spell the kinds the same way,
     with a comment saying apps/ai records it (`apps/api/src/modules/analytics/analytics.service.ts:24`).
   - New Python seam `apps/ai/app/analytics.py`: the `Analytics` protocol (:58),
     `AnalyticsEvent` (:48; `kind` is a Literal of the same five kinds), `BigQueryAnalytics` (:88)
     on `google-cloud-bigquery` with ADC, `Recorder` (:137), which runs each write as a
     background task (holding a reference until it's done) and logs a failure with
     `log.exception(..., kind=...)` (the job's request id and org come along on the log
     context), and `create_analytics(settings)` (:160), which returns None without
     `BIGQUERY_DATASET`. Row shape `_row` (:124) matches the api: `time` ISO 8601 UTC to the
     millisecond with `Z`, `kind`, `user_id`, `template_id`, `video_id`, `score`, `detail` as
     a JSON string. Inserts go through `asyncio.to_thread` (the client blocks) with
     BigQuery's own retry capped at 30 s.
   - `Director.review` records the event right after the score is stored and published
     (`apps/ai/app/director.py:702`), with the take's own `user_id` (the job's is optional)
     and the plan's `video_id` (:643). `create_director` passes `create_analytics(settings)`
     (:812); `Director` owns a `Recorder` (:345).
   - Settings: `BIGQUERY_DATASET` (`apps/ai/app/settings.py:84`), regex
     `^[A-Za-z0-9_]{1,1024}$`, and a validator that refuses it without `GOOGLE_CLOUD_PROJECT`
     (:113). `.env.example` and `docs/environment.md` say both services read it.
   - Production: `BIGQUERY_DATASET: director` for `ai` and `ai-worker`
     (`deploy/environments/production/stack.yaml:38`, `:43`), with two helm-unittest cases
     (`deploy/charts/stack/tests/deployment_test.yaml:120`, `:129`).
   - Dependency: `uv add --project apps/ai google-cloud-bigquery` (pyproject gets
     `google-cloud-bigquery>=3.46.2`, the same `>=` style as the rest; uv.lock regenerated
     by uv). It pulls in `grpcio` and `grpcio-status` too.
   - Tests: `apps/ai/tests/test_analytics.py`: settings on/off, dataset-without-project
     fails at boot, bad dataset names refused, the Recorder off / in the background /
     a failure logged and not raised (unit); BigQuery against a local insertAll stand-in
     (integration): the row shape for two events, the client built once, a 400 raised for
     the Recorder to log. `apps/ai/tests/test_director.py:729`
     `test_a_reviewed_take_is_counted_with_its_score_and_a_failed_one_is_not`: a failed
     review then a successful one, run with no user on the job; exactly one row, with the
     take's user, the video and score 82. The stand-in lives in `tests/fakes.py`
     (`INSERT_ALL`, `bigquery_inserted`, `bigquery_client`, `inserted_rows`): the real
     `google.cloud.bigquery.Client` with anonymous credentials and `api_endpoint` set to the
     stand-in, put in place by monkeypatching `app.analytics.Client` (the same way
     `test_audio.py` handles the GCS client). The app code has no test hook.
   - Types: the client's `insert_rows_json` returns bare `dict`s, which strict basedpyright
     won't accept as known types. Rather than add an ignore, a small `_InsertAll` protocol
     (`analytics.py:67`) types what we use, and the response goes through a `TypeAdapter`.
     No new suppressions.
3. **Important 3 (PartialFailureError with an empty message):**
   - TS: `BigQueryAnalytics.record` catches the error and rethrows the result of
     `refusedRows` (`packages/nest-common/src/analytics.ts:65`, `:105`). That function parses
     the SDK error with zod (`:89`; no casts) and builds `BigQuery refused the event: reason:
     message; ...`. No row data goes in, and there's no `cause` (describeError would log
     the cause's rows). Other errors are rethrown unchanged.
     Test: `analytics.test.ts:163`. The stand-in answers 200 with `insertErrors`; the test
     checks the exact message, that the user id isn't in it, and that there's no `cause`.
   - Python: `_insert` checks `insert_rows_json`'s return value, which is how the Python
     client reports the same partial failure, and raises `AnalyticsRefused` the same way
     (`apps/ai/app/analytics.py:101`). Test:
     `test_rows_bigquery_refuses_name_each_reason_and_never_the_row`.
4. **Minor 4 (skill wording):** `.claude/skills/swap-analytics/SKILL.md:20-23` now says
   "calls `AnalyticsService.record` with one of `AnalyticsKind`". The skill also covers
   the Python twin, its env, how to swap it and its tests. The README's Scaling path row
   lists both seam files.
5. **Minor 5 (relay guard):** `if (justStarted && !this.ended)`
   (`apps/api/src/modules/live/live.relay.ts:220`). Test: `live.test.ts:277`
   `never records a call whose setup completes only after it ended`. The stand-in pauses
   its socket, so the relay's close frame waits while a late `setupComplete` still reaches
   the relay after the browser hung up. The relay reads frames in order, so the test
   waits for the stand-in's socket to close and then checks once. I ran it 3 times and it
   passed every time.
6. **Minor 6 (dataset regex):** `apps/api/src/env.ts:109`, with the same regex in
   `apps/ai/app/settings.py:84`. Tests: `apps/api/src/env.test.ts:38` (refuses `.`, `-` and
   1025 characters) and `test_a_dataset_name_bigquery_would_refuse_is_refused`.
7. **Minor 7 (google-auth-library coupling):** a note in the header of
   `packages/nest-common/src/analytics.test.ts:7-13`: the devDependency has to stay on the
   same major as `@google-cloud/common`'s copy (^11 today), or the SDK stops recognizing
   the client and goes looking for ADC.

### TDD evidence (failing first)

- nest-common partial failure: `expected [Function] to throw error including 'BigQuery
  refused the event: invalid: …' but got ''` (1 failed | 8 passed), then 9/9 passed.
- relay: `expected "vi.fn()" to not be called at all, but actually been called 1 times`,
  then 46/46 passed (3 runs).
- api env: `promise resolved "{ …(2) }" instead of rejecting`, then 9/9 passed.
- ai analytics: collection error (`app.analytics` didn't exist yet), then 9 unit and 3
  integration tests passed.
- ai director: `ValueError: not enough values to unpack (expected 1, got 0)` (no row),
  then it passed.

### Checks (commands and output tails)

- `bun run lint`: every step passed (biome, boundaries, unused/knip, markers, patterns,
  suppressions, prisma, actionlint, zizmor, shellcheck, hadolint, tflint, renovate, turbo
  lint including ruff, ruff format and deptry for apps/ai: "No dependency issues found").
- `bun run check-types`: `Tasks: 24 successful, 24 total`;
  `@repo/ai:check-types: 0 errors, 0 warnings, 0 notes`.
- `bun run test`: `Tasks: 22 successful, 22 total`.
- `bun run --filter @repo/ai coverage` (unit and integration together): `129 passed`.
  `app/analytics.py 100%`, `app/director.py 100%`, `app/settings.py 100%`. The total is
  99.70% because of **`app/telemetry.py` lines 44-45 and branch 56->62**. That file is
  untouched and the gap is older than this task: no Python test sets
  `OTEL_EXPORTER_OTLP_ENDPOINT` for a real start. Someone else is editing
  `tests/test_service.py` in the main checkout right now to cover exactly that.
- `bun run --filter @repo/ai test:integration`: two early runs on the shared default
  services had failures (3, then 1 director tests). Another session's
  `python -m app.worker` was draining the shared Redis test database at the time, and
  each failing test passed when rerun alone. I then followed the coordinator's
  instruction, set up this worktree's own stack (`bun run setup --stack 6`) and reran
  everything below on it: `49 passed, 80 deselected`, exit 0. The ai coverage run on
  stack 6 was `129 passed`, with the same file results as above (only the older
  `telemetry.py` gap). When I finished I stopped the stack's containers with
  `bun run db:down` (stack6 postgres, valkey and mailpit removed). This worktree's `.env`
  still points at stack 6.
- `bun run --filter @repo/api coverage` (`289 passed`), `bun run --filter @repo/nest-common
  coverage` (`125 passed`), then `bun scripts/coverage.ts packages/nest-common/src/analytics.ts
  apps/api/src/env.ts apps/api/src/modules/live apps/api/src/modules/analytics
  apps/api/src/modules/director apps/api/src/server.ts`: `14 source files, 3 reports: 0
  below 100%`. (Across all of `apps/api/src`, four untouched auth/rpc files show gaps when
  only these reports are merged. The full merge covers them from other suites, and this
  round doesn't touch them.)
- `bun run --filter @repo/api test:integration` (stack 6): `8 passed (8)`, `96 passed | 13 skipped`, exit 0.
- `bun run --filter @repo/nest-common test:integration` (stack 6): `7 passed | 1 skipped`, `34 passed | 3 skipped`, exit 0.
- `bun test ./scripts/ ./.claude/hooks/`: `973 pass, 0 fail`.
- `bun run charts:check`: everything passed, including `deploy/charts/stack: unit tests` and
  `production: stack renders`.
- `bun run gen`: no drift (`git status` clean apart from `.superpowers/`).
- `bun run type-coverage packages/nest-common`: 99.97%. The only finding is the older
  `packages/i18n/src/index.ts:51:1 Unused ignore line directive` from round 0.

### Concerns

- `app/telemetry.py` coverage gap and the `packages/i18n` type-coverage directive are both
  older than this task and outside it (see above).
- On the shared default services the ai integration tests are flaky while other sessions
  run theirs. On this worktree's own stack 6 they're all green.
- `google-cloud-bigquery` brings `grpcio` (about 12 MB) into the ai image.
- Shutting down the ai worker doesn't wait for analytics writes still in flight. An
  event recorded in the last moment before SIGTERM can be lost. I accepted that, since
  the writes are fire-and-forget.
