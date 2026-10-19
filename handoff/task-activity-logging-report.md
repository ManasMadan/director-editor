# Activity logging: report

Branch `feat/mm/activity-logging`, rebased onto origin/master at `ae43b93`. Master moved
during the task with #12's CI fixes, and the rebase had one trivial conflict in
`apps/api/src/modules/publish/publish.service.test.ts`, which I resolved. Not pushed, and
no PR.

## Commits

```
cf4af98 test(api): check the Google sign-in and YouTube grant lines, with Google's consent in the harness
c5038eb feat(infra): add People, Who did what and Director dashboards over the activity logs
e946d16 feat(ai): log indexing, reviews and every job as activity lines, and redact secrets
3bd8ae6 fix(api): log a failed sign-in's address only when it is one, and Google's error only as a code
b69bb28 feat(api): log every sign-in, procedure call, live call and publish as an activity line
4389bd3 feat(nest-common): log one activity line per meaningful event, through the services' own logger
```

## Where each piece is defined (once)

- **Line shape**: `packages/logger/src/activity.ts` (zod: `activityLine`,
  `activityActor`, `activityOutcome`, and `ACTIVITY_MESSAGE = "activity"`).
  - It lives in `@repo/logger`, not contracts. Dependency-cruiser's
    `shared-plumbing-has-no-domain` rule stops nest-common from importing
    `@repo/contracts/*` beyond errors, time and objects, and I did not change that rule.
  - `@repo/logger` now depends on `zod`, and `@repo/jobs` has `@repo/logger` as a dev
    dependency (for the export script).
- **Names**: `packages/contracts/src/activity.ts` (`ACTIVITIES`, `activityName`).
  `ANALYTICS_KINDS` moved here from apps/api's AnalyticsService, so TypeScript and Python
  share one list. Python's hand-written Literal is replaced by the generated
  `app/contracts/analytics_kind.py`.
- **Python contracts**: `bun run gen` exports `activity_line.json` and
  `analytics_kind.json` (`packages/jobs/scripts/export-schemas.ts`). They become
  `apps/ai/app/contracts/activity_line.py` and `analytics_kind.py`.
- **Writers**:
  - `logActivity`, `activityLine` and `outcomeOf` in
    `packages/nest-common/src/activity.ts`. They fill in the actor, ip, userAgent,
    requestId and orgId from the AsyncLocalStorage context.
  - apps/api's injectable `RecordActivity` (`apps/api/src/activity.ts`,
    `@InjectActivity()`).
  - `log_activity` in `apps/ai/app/activity.py`.
- **Left alone**: the domain events and audit log (`events.ts`, the worker's audit
  processor). They are a stored contract; activity lines are logs.

## The line

Fields are flattened into one JSON object per line:

```
level, service, msg: "activity",
activity: "auth.signed_in",
actor: { userId, email, name, demo },
orgId, target: { method: "google" },
outcome: "ok" | "refused" | "failed", reason?,
ip, userAgent, requestId, traceId?, durationMs?, userId
```

- `target` holds flat scalars only, which Grafana reads as `target_<key>`.
- Failed lines are logged at `warn`, everything else at `info`.
- Python lines carry the same fields, with `event: "activity"` in place of `msg`.

### Request context on every line

- **Context fields**: `RequestContext` gained `ip`, `userAgent`, `email`, `name` and
  `demo`. `contextFor` sets ip and userAgent.
- **Actor**: once the session resolves, `authed`, `inOrg`, `orgCallerFor` and the auth
  routes set it (`actorContext`).
- **Ids on every Node line**: every line already carried `requestId`, `userId` and
  `orgId` through the mixin; `authed` now sets `orgId` too.
- **`traceId` rename**: pino's OpenTelemetry instrumentation now writes `traceId` and
  `spanId` (it was `trace_id`). Python's `add_trace_ids` does the same.
- **Python bindings**: now `requestId`, `orgId` and `userId`. They were snake_case, even
  though log.py claimed they matched the Node fields.
- **Job meta**: `jobMetaFromContext` now copies `orgId` too.
- **Live call**: the raw WebSocket upgrade now runs in its own request context
  (`upgradeContext`): a request id, the IP resolved through trusted proxies (new
  `createClientAddress`), and the user agent.

## Events covered

| Activity | Written by |
|---|---|
| `auth.signed_up` (method), `auth.signed_in` (method: password, email-code, google, passkey, two-factor, demo), `auth.signed_out`, `auth.session_revoked` (reason), `auth.google_linked`, `auth.youtube_granted` | better-auth's database hooks (`auth-hooks.ts`, logic in `auth-activity.ts`). `youtube_granted` is an account update that writes the upload scope: better-auth writes the scope only through linkSocial, so I track it from before to after the write in each request. |
| Failed sign-in or sign-up, and `auth.demo_refused` | `auth.routes.ts`, from the response. The reason is better-auth's code, `RATE_LIMITED`, or Google's `error` (only when it looks like a code). The email is logged only when it parses as an email, so a password typed into the email field is never logged. |
| Every procedure call: `api.called`, plus Director's own names (`director.index_requested`, `plan_opened`, `scene_checked`, `take_recorded`, `cut_saved`, `publish_copy_drafted`, `media_viewed`, `published`) | One oRPC client interceptor, outside the error mapping: `apps/api/src/rpc/procedure-activity.ts`. Each line has the outcome, error code, duration, and allow-listed ids from the input and output. |
| `director.call_started` (ok, or refused or failed with a code), `director.call_ended` (reason HUNG_UP, TIMEOUT or a code; duration; whether it started) | `live.gateway.ts`. The relay's `run()` now resolves `{code, startedAt}`. The callback from Gemini's socket is bound back to the request context with `AsyncResource.bind`. |
| `director.publish_started` | `PublishService.upload`, once the cut is claimed |
| `director.indexed` (planId, videoId, model, input and output tokens, duration; failed or refused with a code) | `apps/ai/app/director.py` (`analyze`, `_fail_plan`) |
| `director.take_reviewed` (score, shot, kind, tokens; failed or refused) | `director.py` (`review`, `_fail_take`) |
| `job.finished` (queue, job, jobId, attempt, event name, `final` on failure, duration), for the user, org and request in the job's meta | The `JobProcessor` base in nest-common (worker and notifications; its `completed` and `failed` events), and `run_job` in `apps/ai/app/worker.py` |

Two other changes along the way:

- **`sessionMethod` fix**: it mapped `/sign-in/email-otp` to `other`, which also affected
  the audit events. It now maps to `email-code`.
- **`allowsUploads` moved** to `@repo/contracts/api`. Both publishing and the auth hooks
  use it, and the auth hooks can't import the publish module without a cycle.

## Redaction

Nothing that reaches a log line can carry a sign-in code, a password, a token or a
cookie. Grafana is shared with the owner's team, so the dashboards show only emails,
names, IPs and user agents.

### What each logger censors

- **`@repo/logger`** (Node):
  - New redact paths: `req.body` and `body`.
  - More sensitive keys: `access_token`, `refresh_token`, `id_token`, `sessiontoken` and
    `session_token`, `clientsecret` and `client_secret`, and `set-cookie`.
  - Any string containing a presigned signature (`X-Amz-Signature`, `X-Goog-Signature`
    or `Signature`) loses its query.
- **apps/ai**: a new `redact` structlog processor (`app/log.py`) with the same keys and
  URL rule. It had no redaction before.

### Tests that prove it

- `packages/logger/src/index.test.ts`, "never writes a code, password, token, cookie,
  signature or request body".
- `apps/ai/tests/test_activity.py`, `test_no_line_carries_a_secret_or_a_signed_url`. It
  runs in a subprocess with the production logging config.
- `apps/api/test/activity.integration.test.ts`. After a sign-up, a code sign-in and a
  failed password sign-in, the real API's stdout contains neither the password nor the
  code.

## Dashboards

A new platform chart, `deploy/platform/dashboards`, and its add-on
`deploy/platform/addons/observability/dashboards.yaml` (namespace `observability`,
wave 10).

### How the chart works

- **ConfigMaps**: one per dashboard, labelled `grafana_dashboard: "1"`, with the
  annotation `grafana_folder: Director`.
- **Dashboard JSON**: in `files/`. The namespace (`director-editor`) and the Jaeger uid
  (`jaeger`) are filled in from the chart's values.
- **Variables**: each dashboard has a Loki datasource variable (so no Loki uid is
  assumed) and a `namespace` variable (`label_values(namespace)`).

### The three dashboards

- **People** (`director-people`):
  - Stats: sign-ins, active people, new accounts and failed sign-ins.
  - Time series: sign-ins by method, and failures by reason.
  - Latest sign-ins table: email, name, method, demo, IP, browser, user id and a trace
    link. Each email links to Who did what.
  - A failed sign-ins table, and a log panel for the demo account.
- **Who did what** (`director-who-did-what`):
  - A `person` textbox that takes an email or a user id, used as a line filter.
  - Activity by kind, and a where-from table.
  - A timeline table with trace links to Jaeger.
  - Every log line that names the person.
- **Director** (`director-activity`):
  - Indexing by outcome, and tokens spent.
  - Calls, why they ended, and call length.
  - Takes and scene checks, and the average score.
  - Cuts and publishes.
  - A refusals and errors table, and a failure log.

### Checks

- **`scripts/dashboards.test.ts`** checks:
  - the JSON parses and every uid is unique;
  - every query has `{namespace="$namespace"}`;
  - every `activity="…"` exists in `ACTIVITIES`.
- **helm-unittest**: a suite for the new chart.
- **`scripts/charts.ts`**: the chart is in OWN_CHARTS.
- **`scripts/charts.test.ts`**: its kubeconform count is now derived from
  `platformRenders`, so the Loki add-on won't break it.

## Docs

- **New `docs/observability.md`**: what's logged, what isn't, the line, how to follow
  one person, LogQL examples, and how to add an activity.
- **`docs/README.md`**: a new row for it.
- **`deploy/README.md`**: a paragraph in the Observability section.
- **`docs/environment.md`**: now says `traceId`.

## Test results

All on local stack 6, which I stopped at the end with `bun run db:down`.

- **Checks**: everything passed.
  - `bun run test` (every unit suite) passed.
  - `bun run check-types` passed.
  - `bun run type-coverage` passed once rebased on #12, which fixed master's own gap.
  - `bun run lint` passed, apart from one existing Biome warning in
    `scripts/image-scan.test.ts`.
  - `bun run gen` leaves no drift.
- **TypeScript integration** (api, nest-common, worker, notifications, webhooks, jobs,
  db): all passed. In api, 150 passed and 33 were skipped: the `files`-tagged suites,
  which need RustFS.
- **apps/ai `coverage`** (unit and integration together): 334 passed, at 100% of lines
  and branches.
- **`bun run charts:check`**: passed.
- **`bun test ./scripts/ ./.claude/hooks/`**: 976 pass and 2 fail, both in
  `scripts/pre-push.test.ts`. They expect the default Postgres port 55432, but this
  worktree's `.env` uses stack 6's port 56032. That's my local setup, not this change.
- **Not run**:
  - The web browser suites (as instructed).
  - The `files`-tagged suites.
  - The full merged `test:coverage`, which needs the full profile.
  - `director.publish_started` is only exercised by the `files`-tagged publish suite.

## Concerns and notes for the controller

- **Coordination with the Loki and Grafana work**:
  - The queries assume a Loki label called `namespace` and JSON lines on stdout.
  - The Loki datasource uid isn't assumed: each dashboard picks it from a variable.
  - Trace links in log panels rely on the other agent's derived field. Tables link to
    the Jaeger uid `jaeger` instead (the chart's `jaegerUid` value).
  - The dashboards only go into a Director folder if the Grafana sidecar sets
    `folderAnnotation: grafana_folder`. Otherwise they land in General.
- **`traceId` rename**: alerts, derived fields and saved queries that match `trace_id`
  must now use `traceId`, for Node and Python alike.
- **Jobs in Who did what**: job lines carry the user id but no email, so the dashboard
  finds someone's background jobs by user id, not by email (the docs say this).
  Carrying the email in job meta would also need the API's token for the AI service to
  carry it.
- **What a publish logs**:
  - `director.published` is logged when the procedure ends: ok, or refused or failed
    with a code.
  - "Publish attempted" is `director.publish_started`, logged only once the cut is
    claimed.
  - A refusal before the claim (the demo account, or no YouTube grant) shows only on
    `director.published`.
- **`auth.google_linked`** fires for every new Google account row, including Google
  sign-ups.
- **Test harness**: apps/api's harness gained `googleConsent` and `throughFakeGoogle`,
  moved from the publish test. The `files`-tagged publish suite uses them too, but I
  couldn't run it without RustFS.
- **Log volume**: every procedure call writes a line, including the frequent
  `director.speak` calls during a shoot and opening the realtime subscription. Fine at
  hackathon traffic; filter by `activity` in Loki if it gets noisy.
- **Report location**: this report is in the scratchpad, not at the path the brief gave.
  The worktree's tools refused to write outside the worktree.

## Fix round 1 (review 1)

Branch rebased on origin/master `ae43b93` (unchanged), every commit re-authored as
Manas Madan <manasmadan08@gmail.com>, pushed to `origin/feat/mm/activity-logging` (`2431318`).

New commits: `b9246db` fix(ai), `e08c257` fix(logger), `fb4eba2` fix(api), `2431318` fix(infra).

- Important 1: Call length, Average take score and both token stats now use
  `| json <fields>` and `by (activity)`; `scripts/dashboards.test.ts` refuses an
  `unwrap` query without `]) by (` or with a bare `| json |`. Every other panel was
  already wrapped in `sum`/`sum by`/`count`.
- Important 2: `caller` is `async` and clears the previous request's contextvars;
  `test_a_request_s_lines_carry_its_ids_and_its_caller` checks the endpoint sees them.
- Minor 1-3: Errors are serialized and scrubbed (any key, plus the `err` serializer,
  merged into nest-common's pino-http serializers); the message is scrubbed in
  `hooks.logMethod`; credential fields match by pattern in any casing; only secret query
  parameters lose their value. Same rules in Python. Tests cover real Errors, messages,
  exception text and casing styles.
- Minor 4: in-memory throttle (`createActivityThrottle` in nest-common, one
  implementation): `plan_opened`, `media_viewed`, `scene_checked` at most once per user,
  short and shot per 5 minutes per replica; failures always logged.
- Minor 5: People's email link percent-encoded; Who did what filters
  `actor_email="$person" or actor_userId="$person"` (and `userId` on the all-lines panel);
  descriptions fixed.
- Minor 6: docs say tools are on their own hosts under director.mmadan.in behind the
  shared password (`deploy/platform/internal-tools`, from the devops branch), port-forward
  still works.
- Minor 7: `/admin/*` paths keep the admin as actor and put the person in `target`.
- Minor 8: link-callback errors are a failed `auth.google_linked`; `auth.signed_up` is
  logged after the workspace transaction; a call hung up while its plan loads writes
  `director.call_ended` (HUNG_UP, started false).

Checks: lint, check-types, type-coverage, `bun run test`, `bun run gen` (no drift),
charts:check, TS integration (api 150 passed / 33 files-tagged skipped; nest-common,
worker, notifications, webhooks, jobs, db all pass), apps/ai coverage 354 passed at 100%.
Scripts/hooks: 979 pass, 2 fail (pre-push.test.ts, port 55432 vs this worktree's stack-6
56032; environmental). Stack stopped with `bun run db:down`.
