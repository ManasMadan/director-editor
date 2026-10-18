# Observability: activity logs

Every service writes one structured log line for each meaningful thing someone does:
signing in, calling a procedure, indexing a short, a live call, a take reviewed, a
publish, a background job. Read together in Grafana, these activity lines follow any
person through the app: who signed in and how, from where, and everything they did after.

Traces (Jaeger), metrics (Prometheus) and alerts are described in
[deploy/README.md](../deploy/README.md#observability). This page covers the logs.

## Where the lines go

Each service logs JSON to stdout through its own logger: pino in the Node services
(`@repo/logger`, with `@repo/nest-common`'s request context on top) and structlog in
`apps/ai` (`app/log.py`). Nothing else ships logs. On a cluster with observability on,
Alloy sends every pod's stdout to Loki, labelled with its `namespace`, `pod`,
`container` and `app_kubernetes_io_component` (the pod's component label, or else its
name: `api`, `worker`, `ai`, ...), and Grafana reads it (`deploy/platform/values/alloy.yaml`
and `loki.yaml`). Locally, `bun dev` prints the same lines, readable.

Every line written while handling a request or a job carries `requestId`, `userId` and
`orgId` once they're known, and `traceId` (and `spanId`) while tracing is on, in every
service, with the same names. Activity lines carry more: who the person is and where they
came from.

## The activity line

The shape is defined once, in `packages/logger/src/activity.ts`, and the names in
`packages/contracts/src/activity.ts`. `bun run gen` exports both to the Python service
(`apps/ai/app/contracts/activity_line.py`). The message is always `activity`.

| Field | What it holds |
|---|---|
| `activity` | what happened, e.g. `auth.signed_in`, `director.take_reviewed` (the list below) |
| `actor` | `userId`, `email`, `name`, and `demo` when it's the shared demo account. A failed sign-in has only the `email` that was tried |
| `orgId` | the workspace |
| `target` | what it was about and its details, flat: ids, a method, a score, token counts. Grafana reads each as `target_<key>` |
| `outcome` | `ok`, `refused` (a limit, a permission, the demo account, bad input: a 4xx) or `failed` (our fault or a provider's) |
| `reason` | why it was refused or failed: an error code, or the provider's reason |
| `ip`, `userAgent` | the client's address (resolved through `TRUSTED_PROXIES`) and browser |
| `requestId`, `traceId` | the request, and its trace when tracing is on |
| `durationMs` | how long it took, where that means something |

Failed lines are written at `warn`, the rest at `info`. When an admin acts on someone
(creating their account, impersonating them, revoking their session), the admin is the
`actor` and the person it was done to is in `target` (`userId`, `email`).

### What is logged

| Activity | When | Written by |
|---|---|---|
| `auth.signed_up` | an account was made; `target.method` | the auth hooks (`apps/api/src/auth/auth-hooks.ts`), or `auth.routes.ts` when it failed |
| `auth.signed_in` | a session started; `target.method` is `password`, `email-code`, `google`, `passkey`, `two-factor` or `demo`. Failed ones carry better-auth's code (or Google's `error`) as `reason` | the session hook, and `auth.routes.ts` for failures |
| `auth.signed_out`, `auth.session_revoked` | a session ended; a revoked one says why (`revoked`, `password-change`, ...) | the session hook |
| `auth.google_linked`, `auth.youtube_granted` | a Google account was linked (at sign-up or later), or allowed to upload to YouTube; a link Google refused is a failed `auth.google_linked` with Google's `error` | the account hooks, and `auth.routes.ts` for failures |
| `auth.demo_refused` | the demo account tried to change itself | `auth.routes.ts` |
| `api.called` | any other procedure call; `target.procedure`, the error code when it didn't end ok | one interceptor around every procedure (`apps/api/src/rpc/procedure-activity.ts`) |
| `director.index_requested`, `director.plan_opened`, `director.scene_checked`, `director.take_recorded`, `director.cut_saved`, `director.publish_copy_drafted`, `director.media_viewed`, `director.published` | the Director procedures, under their own names, with the ids from the call (`videoId`, `shotIndex`, `cutId`, the take or cut made, a publish's `youtubeVideoId`). `plan_opened`, `media_viewed` and `scene_checked` are reads the screens repeat on a timer, so each is logged at most once per person, short and shot every five minutes (failures always) | the same interceptor |
| `director.indexed` | the AI worker finished watching a short: `model`, `inputTokens`, `outputTokens`, or why it failed (`refused` when the workspace was out of tokens) | `apps/ai/app/director.py` |
| `director.asset_drawn` | the AI worker drew (or gave up on) the default image of one of a plan's assets: `planId`, `assetId`, `model`, `inputTokens`, `outputTokens`, or why it failed (`refused` when the workspace was out of tokens) | `apps/ai/app/assets.py` |
| `director.take_reviewed` | a take's review: its `score` and tokens, or why it failed | `apps/ai/app/director.py` |
| `director.editor_request` | a request in the editor: its `outcome`, how many edits, spoken or typed, and tokens | `apps/ai/app/director.py` |
| `director.call_started`, `director.call_ended` | a live call started (or was refused, with its code), and how it ended: `reason` is `HUNG_UP`, `TIMEOUT` or an error code, with its length | `apps/api/src/modules/live/live.gateway.ts` |
| `director.publish_started` | a cut was claimed and its video is on its way to YouTube | `apps/api/src/modules/publish/publish.service.ts` |
| `job.finished` | a background job ran, in the worker, notifications or the AI worker: its queue, job, attempt and outcome, for the user and request it ran for | `JobProcessor` (`packages/nest-common`), `apps/ai/app/worker.py` |

### What isn't

Never a sign-in code, a password, a token (OAuth, session, API key), a cookie, a request
body, or a presigned URL's signature, and no message content: no transcripts, camera
frames, titles or posts someone typed. The target of a procedure call is an allow-list
of ids and small facts, never the input itself. Emails and IP addresses are logged:
they're what the admin views are for.

Both loggers also redact on their own, in case a line carries a secret by mistake:
- every field named like a credential, at any depth and in any casing style (`password`,
  `otp`, anything ending in `token`, `apiKey` or `api_key`, `serviceSecret`, `cookie`,
  `authorization`, `credentials`, ...), and request bodies;
- in any text, the message and errors included, the value of every secret query
  parameter (a presigned URL's `X-Amz-Signature` and `X-Amz-Credential`, a `token`, a
  `key`, an OAuth `code`), keeping the rest, so a stack trace naming one stays readable.

`packages/logger/src/index.test.ts` and `apps/ai/tests/test_activity.py` log each of
those, in fields, messages and real errors, and check none reaches the output, and
`apps/api/test/activity.integration.test.ts` checks the real API's lines after a sign-up,
a sign-in and a failed one.

## Following one person in Grafana

The dashboards are in `deploy/platform/dashboards` (an observability add-on, so on every
cluster that has Grafana), each opening on the application's namespace:

- **People**: sign-ins over time by method, the latest sign-ins (who, method, address,
  browser), active people, new accounts, failed sign-ins and why, and the demo account.
- **Who did what**: one person's timeline. Put exactly their email or user id in
  *Person*; the People dashboard's emails link there. An email finds their activity
  lines; their user id also finds their background jobs and every other line of their
  requests, errors included, which carry only the id (People's sign-in table shows it).
  The Timeline's trace ids open the trace in Jaeger.
- **Director**: indexing (and its tokens), live calls and why they ended, takes and
  their scores, cuts and publishes, and every refusal and failure by code.

Grafana, Jaeger, Prometheus and Alertmanager are served on hosts of their own under the
cluster's zone (production: <https://grafana.director.mmadan.in>,
<https://jaeger.director.mmadan.in>, and so on), behind one HTTP password the gateway
asks for first, then Grafana's own sign-in. That's the internal tools add-on
(`deploy/platform/internal-tools`, its `internal-tools-auth` Secret in
`deploy/platform/secrets/<env>/`), described in deploy/README.md's "Internal tools".
Anyone with that password sees these dashboards, so they hold emails, names and
addresses but never a secret. Without it, a port-forward still works:
`kubectl -n observability port-forward svc/kube-prometheus-stack-grafana 3000:80`, then
<http://localhost:3000>. In Grafana, the Loki data source has the uid `loki` and
Jaeger's `jaeger`; a log line's trace id opens its trace, and a trace's "Logs in
Grafana" opens its lines.

The same in Explore, as LogQL:

```logql
{namespace="director-editor"} |= "ada@example.com" | json | actor_email="ada@example.com"
{namespace="director-editor"} |= "auth.signed_in" | json | activity="auth.signed_in" | outcome!="ok"
sum by (target_method) (count_over_time({namespace="director-editor"} |= "auth.signed_in" | json | activity="auth.signed_in" [1h]))
```

## Adding an activity

1. Add its name to `ACTIVITIES` in `packages/contracts/src/activity.ts` and run
   `bun run gen` (the Python service gets it too).
2. Log it where it happens: in apps/api with the injected `RecordActivity`
   (`@InjectActivity()`, `src/activity.ts`); in another Node service with `logActivity`
   from `@repo/nest-common`; in apps/ai with `log_activity` (`app/activity.py`). A new
   procedure needs nothing: it's logged as `api.called`, or under its own name once it's
   in `PROCEDURE_ACTIVITIES` (`apps/api/src/rpc/procedure-activity.ts`).
3. Put only ids and small facts in `target`, never what someone typed.
4. Use it in a dashboard if it belongs there: `scripts/dashboards.test.ts` checks every
   activity a dashboard asks for exists.
