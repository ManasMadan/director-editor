# Review 1: feat/mm/activity-logging (cf4af98, base origin/master ae43b93)

Read-only review. The checkout is unchanged (`git status` clean, HEAD cf4af98). I ran these focused tests and all passed: logger index/activity (9), api procedure-activity/auth-activity (21), api live/http-context/server (66), nest-common activity/job-processor/context/logging (21), and `scripts/dashboards.test.ts` (4). I also ran two small probes outside the suites, a pino Error passthrough and a FastAPI contextvars check. Both are described below.

### Verdict per risk, with evidence

1. **Secret leakage: pass, with minor gaps.**
   - **Failed sign-in.** It parses only `{ email: z.email() }` from the raw body (`apps/api/src/auth/auth-activity.ts:67-79`). A password typed into the email field fails `z.email()` and is dropped. The code and password are never read.
   - **Google callback errors.** Only a `^[\w.-]{1,64}$` code is logged, otherwise `unreadable_error` (`auth-activity.ts:95-107`).
   - **Procedure targets.** They come from an allow-list (`apps/api/src/rpc/procedure-activity.ts:34-54`). No input bodies, titles or frames are logged.
   - **Node logger.** It redacts `req.body` and `body` (`packages/logger/src/index.ts:28-35`) and has more token keys. Signed URLs lose their query (`index.ts:73-78`), and `formatters.log` scrubs every line (`index.ts:123`).
   - **Python.** It has a `redact` processor that runs after `format_exc_info`, so exception text is scrubbed too (`apps/ai/app/log.py:64-106`).
   - **Request URLs.** They were already query-redacted (`packages/nest-common/src/logging.ts` serializer, and `bootstrap.ts` onResponse, which skips /health).
   - **Job errors.** `describeError` copies only type, message, stack and cause, so no headers or config reach the log.
   - **The redaction tests are real:**
     - real pino with the production `loggerOptions` (`packages/logger/src/index.test.ts`);
     - the real API's stdout after sign-up, OTP sign-in and a failed password sign-in (`apps/api/test/activity.integration.test.ts`);
     - the production structlog config, run in a subprocess (`apps/ai/tests/test_activity.py`).
   - **Gaps:** see Minor 1-3.
2. **Performance and volume: acceptable.**
   - Per call, the cost is two shallow zod `.catch` parses of declared keys only (frames and bodies are not walked), one extra `findUniqueOrThrow` per sign-in (`auth-hooks.ts:240`), and scrub copies that were already there.
   - Health checks are not logged.
   - **Noise** (Minor 4): polled procedures write a line on every poll. `director.plan` and `director.media` poll every 3 s, `checkScene` runs every 6 s while filming, and takes and shots also poll. Each request also has its "request completed" line, so log volume roughly doubles. That's fine at hackathon traffic.
3. **Actor context: correct.**
   - Each HTTP and auth request runs in its own `runWithContext` store, and `updateContext` mutates only that store.
   - The WebSocket upgrade now gets its own store (`live.gateway.ts:218`). Gemini's callback is bound back to it with `AsyncResource.bind` (`live.gateway.ts:156`).
   - The `youtube_granted` before/after pairing keys on better-auth's endpoint context. I checked that it's the same object in both hooks (`node_modules/better-auth/dist/db/with-hooks.mjs:44-76`). Scope is written only through linkSocial (`oauth2/link-account.mjs:51-61`). The token refresh and sign-in updates omit it, so there are no repeat lines.
   - Job lines take the user, org and request from the validated job meta (`jobMeta` already allowed `orgId`).
   - The demo flag comes from the user row through `actorContext`.
   - **Exception** (Important 2): apps/ai's per-request bindings never reach the endpoint's log lines.
4. **Boundaries and repo rules: pass.**
   - nest-common imports only `@repo/contracts/errors` and `/objects`.
   - The shape is in `@repo/logger/activity` and the names in `@repo/contracts/activity`.
   - `ANALYTICS_KINDS` moved from apps/api into contracts and is now shared with Python. This replaces a duplicate rather than adding one.
   - `allowsUploads` moved to `@repo/contracts/api`. All three callers were updated, and it's tested in `publish.test.ts`.
   - The generated schemas and Python models are committed.
   - No casts or suppressions in source: the casts in the diff are in tests, which type-coverage excludes (`scripts/type-coverage.ts:21-23`).
   - Audit events and the outbox are left alone, which is reasonable: activity lines are logs, not a stored contract.
5. **`trace_id` → `traceId`: pass.**
   - No reader of the old field remains in the branch (searched with grep, excluding node_modules).
   - The pino instrumentation supports `logKeys` (checked in the installed types), and Python's `add_trace_ids` was renamed too.
   - The Loki derived field on the devops branch matches both spellings (`chore/mm/prod-observability:deploy/platform/values/kube-prometheus-stack.yaml:91`).
   - docs/environment.md was updated.
6. **Dashboards: mostly fine, with one real query bug** (Important 1).
   - The JSON is valid and panel ids are unique within each dashboard.
   - The data source is a `type: datasource` variable. The only hard-coded uid is Jaeger, filled in from the chart value `jaegerUid`, which matches `uid: jaeger` on the devops branch.
   - The labels match Alloy's `namespace`.
   - `json` flattening gives `actor_email` and `target_method`, which matches the line shape.
   - The sidecar on the devops branch has `searchNamespace: ALL` and `folderAnnotation: grafana_folder`, so the folder annotation works.
7. **Tests: real behaviour.**
   - Auth goes through the fake Google: `googleConsent` and `throughFakeGoogle` intercept only better-auth's token and certs fetches.
   - BullMQ runs on real Valkey, and the API's real stdout is captured.
   - The logger is mocked only in the unit tests of pure helpers.
8. **Commit messages: pass.**
   - All six are Conventional with a scope and written in first person.
   - None mention AI or co-authors. "ai" appears only as the workspace scope.
   - Authorship is mixed (Minor 9).

### Issues

**Critical:** none.

**Important**

1. **The averages are wrong in two Director panels.** "Call length" and "Average take score" are at `deploy/platform/dashboards/files/director.json:123` and `:156`.
   - **What:** `avg_over_time(... | json ... | unwrap X [$__interval])` has no `by` clause. An unwrapped range aggregation keeps every label, and `| json` turns `requestId`, `traceId`, `actor_*` and `time` into labels.
   - **Why it matters:** every call or take becomes its own series. The panels show one point per line rather than an average. Past Loki's default `max_query_series` (500) in the selected range, they fail outright.
   - **Fix:** group the result, e.g. `avg_over_time({…} |= "director.call_ended" | json activity, durationMs | activity="director.call_ended" | unwrap durationMs | __error__="" [$__interval]) by (activity)`. Alternatively use `sum(sum_over_time(…unwrap…)) / sum(count_over_time(…))`. Do the same for `target_score`.
   - It's worth a line in `scripts/dashboards.test.ts` that rejects an `unwrap` query without an outer aggregation or a `by`.
2. **apps/ai request lines carry no `requestId`, `orgId` or `userId`.** The binding is in `apps/ai/app/auth.py:59-69`.
   - **What:** `caller` is a sync FastAPI dependency, so FastAPI runs it in the threadpool. Its `bind_contextvars` happens in a copied context and never reaches the async endpoint.
   - **Evidence:** I ran a minimal FastAPI app under `uv run` in apps/ai. A sync dependency binds `userId`, and the endpoint's `get_contextvars()` returns `{}`.
   - **Why it matters:** the bug predates this branch, but the brief's point 3 requires it ("every log line in that request"), and the branch's new `log.py` docstring says these fields are "bound by app/auth.py". Activity lines are unaffected because they're written in the worker, where `_bound` is a context manager in the same task. Other AI request lines, including errors, can't be followed per person.
   - **Fix:** make `caller` `async def`, since `verify` is a cheap HMAC JWT check, or bind in a middleware. Add a test that an endpoint's log line carries `requestId` and `userId`.

**Minor**

1. **Redaction misses a raw `Error` and the message string** (`packages/logger/src/index.ts:91`).
   - `scrub` returns `Error` instances untouched, and `formatters.log` never sees `msg`.
   - **Probe:** `log.error({ err: new Error("…?X-Amz-Signature=…") })` and `log.info({}, "…?X-Amz-Signature=…")` both wrote the signature in full.
   - **Exposure today:** small. Callers use `describeError`, which gives plain objects. The only raw `err: error` is the outbox relay's DB errors (`apps/worker/src/outbox/relay.service.ts:136`).
   - The unit test's `err: { message }` is a plain object, so it doesn't cover the Error case.
   - **Fix:** add an `err` serializer that scrubs its output, plus a test that logs a real `Error`.
2. **Signed-URL redaction drops too much** (`index.ts:76-78`, `apps/ai/app/log.py:75`).
   - Everything after the first `?` in the string is dropped. For a stack trace or exception text containing a signed URL, that loses the rest of the trace. A `?` in "why?" earlier in the text cuts even more.
   - **Fix:** replace only the matched URL's query, using a regex replace over `https?://\S+\?\S*`.
3. **The sensitive-key list matches exact names only.**
   - Fields such as `api_key`, a bare `x-api-key` outside `req.headers`, `serviceSecret` or `client-secret` are not caught.
   - Nothing logs one today. Consider a suffix match on `secret`, `token` and `password` (a later refactor could break that).
4. **Polled reads are logged as actions.**
   - `director.plan_opened` and `director.media_viewed` fire on every 3 s refetch while something is in progress (`packages/client/src/api/director/plan.ts:17`, `media.ts:13`). `scene_checked` fires every 6 s while filming.
   - "Opened" overstates this. Either accept it (and say so in docs/observability.md) or count only the first call per request id or per minute.
5. **Who did what: the person link and filter.**
   - **Link:** People's email link uses an unencoded `${__value.raw}` (`people.json:228`), which breaks on `+` addresses. Use `${__value.raw:percentencode}`.
   - **Substring match:** `|= "$person"` matches substrings, so `ada@x.com` also matches `nada@x.com`.
   - **Panel text:** with an email, "Everything logged for them" shows only activity lines, because other lines carry only `userId`, yet its description says "activity or not".
6. **Docs disagree with the devops branch on Grafana access.** `docs/observability.md:92` says Grafana is reachable only by `kubectl port-forward`. The devops branch serves it at `grafana.<zone>` behind the gateway's basic auth. Reconcile when merging.
7. **The acting person can change mid-request** (`auth-hooks.ts:166` and `:276`).
   - `updateContext(actorContext(user))` in `user.create.after` and `session.create.after` hands the rest of the request to the new user.
   - For an admin creating a user or impersonating one, the admin's own later lines (and the `auth.signed_in` actor) name the target, not the admin.
8. **Smaller mislabels:**
   - A Google error on a link-social callback is logged as `auth.signed_in` failed.
   - `auth.signed_up` is written before the workspace transaction, so a rollback still leaves an "ok" line.
   - A call the browser hangs up on while the plan loads writes no line (`live.gateway.ts` `return` before the relay).
9. **Commit authorship.**
   - 4389bd3 and b69bb28 are authored by `Manas Madan <manas.madan@synaptic.com>`. The owner's rule for this project is never the work email: use manasmadan08@gmail.com.
   - The other four commits are authored by the placeholder `t <t@example.com>`.
   - Fix the authors before merging into the devops PR.

### Assessment

**Needs fixes.** The redaction is solid, it is tested against real output, and it does what the brief asks. The two Director panels give wrong numbers, and AI request lines don't name the user, which the brief requires. Both are small fixes. Fix the commit authors before merging too.
