# Activity logging: who did what, and who signed in

The owner wants to see, as admin, everything people do on the app (above all the hackathon judges): who
signed in and how, and every action after that, traceable per person in Grafana. Logs go to Loki: another
agent is deploying Loki, Grafana and Jaeger in production right now. It collects every pod's stdout with
labels `namespace`, `pod`, `container` and `app.kubernetes.io/component`, and Grafana links `traceId` to
Jaeger.

## What to build

1. **One activity log line per meaningful event**, structured JSON through the services' existing
   loggers (pino via `@repo/nest-common` in the Node services, `app/log.py` in apps/ai). Never add a second
   logging library. Each line has a stable shape:
   `{ "activity": "<event>", "actor": { "userId", "email", "name", "demo" }, "orgId", "target": {...},
   "outcome": "ok"|"refused"|"failed", "reason"?, "ip", "userAgent", "requestId", "traceId", "durationMs"? }`.
   Define the event names and the shape once, in a shared package (look for an existing audit or events
   catalog first: `packages/jobs` events, the worker's audit log, the api's `AnalyticsService` that
   writes BigQuery `director.events`; reuse or extend rather than duplicate, per CLAUDE.md principle 3).
2. **Events to cover at minimum:**
   - Auth: sign-up, sign-in (method: email code, password, Google, passkey, demo account), failed
     sign-in (with reason, never the code or password), sign-out, session revoked, Google account linked
     or the youtube.upload scope granted, demo account refusals.
   - Every API procedure call: procedure name, actor, outcome, error code, duration. One interceptor or
     middleware, not code in each procedure.
   - Director: index requested, finished or failed (video id, model, tokens used), template or plan
     opened, live call started or ended (duration, why it ended), scene check, take recorded and
     reviewed (score), cut saved, publish copy drafted, publish attempted, succeeded or refused (code),
     media viewed.
   - Background work: the worker's and ai worker's jobs, logged with the user they ran for.
3. **Request context everywhere:** the actor is resolved once per request (session) and carried by the
   logger's child bindings or AsyncLocalStorage, so every log line in that request, not only activity
   lines, has `userId`, `orgId`, `requestId` and `traceId`. Same for queue jobs (carry the actor in the
   job payload if it isn't there; payloads are validated with `parseJob`).
4. **Never log secrets:** sign-in codes, passwords, tokens (OAuth, session, API keys), signed URLs'
   signatures, cookies or full request bodies. Redact through pino's `redact` paths and a test that
   proves it. IPs and emails are fine (the owner's own admin view), but no message content.
5. **Grafana dashboards** in the repo as ConfigMaps labelled `grafana_dashboard: "1"`, alongside the
   observability add-on (read deploy/platform and coordinate with the layout there; the other agent
   makes Grafana's sidecar watch every namespace):
   - "People": sign-ins over time by method, a table of the latest sign-ins (who, method, IP, user agent),
     active users, failed sign-ins.
   - "Who did what": a per-person timeline of activity, with an `email` or `userId` variable, linked to
     the traces.
   - "Director": indexing, calls, takes, cuts and publishes, with outcomes and errors.
   LogQL against the JSON fields above (`| json | activity="..."`).
6. Docs: a section in docs/observability.md or the closest existing doc on what's logged, what isn't,
   and how to follow one person in Grafana.

## Rules

Read CLAUDE.md and the rules for the areas you touch (api, python, jobs and events, security, tests,
docs). TDD, 100% coverage of what you change (`bun run test` and the area's integration tests on your own
stack: `bun run setup --stack 6`, stop it at the end with `bun run db:down`). Don't run web browser test
suites locally (the owner's instruction): the web app shouldn't need changes for this. Type and lint
clean, `bun run gen` drift-free. Commits `--no-verify`, Conventional with a workspace scope, first
person, never mention AI/Claude/co-authors. Never `git stash`.

Work on branch `feat/mm/activity-logging` from origin/master, in your worktree. Don't open a PR: the
controller merges it into the devops PR. Write the report to
/Users/manas.madan/Desktop/code/director-editor/.superpowers/sdd/2026-10-18-director-hackathon/task-activity-logging-report.md
(events covered, the line shape, the redaction test, dashboards, commits, test results, concerns), and
return a short status.
