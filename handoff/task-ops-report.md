# Ops report: production internal tools and observability

Branch `chore/mm/prod-observability` (from origin/master), head `8afda52`, pushed. No PR
opened. Every cluster change, in order, is in `ops-cluster-log.md` next to this file.

## What's live

| Tool | URL | Its own login |
|---|---|---|
| Grafana (metrics, Loki logs, Jaeger traces) | https://grafana.director.mmadan.in | admin |
| Argo CD | https://argocd.director.mmadan.in | admin |
| Jaeger | https://jaeger.director.mmadan.in | none |
| Prometheus | https://prometheus.director.mmadan.in | none |
| Alertmanager | https://alertmanager.director.mmadan.in | none |
| Stalwart admin | https://mail-admin.director.mmadan.in (goes to /admin/) | admin@director.mmadan.in |
| RustFS console, uploads | https://storage.director.mmadan.in (goes to /rustfs/console/) | the server's keys |
| RustFS console, Postgres backups | https://backups.director.mmadan.in | the server's keys |

Loki has no UI of its own; it's read through Grafana (Explore, data source "Loki").

Every host asks for one shared basic-auth login first (Envoy Gateway SecurityPolicy).
No IP allow-lists or other restrictions, as the owner asked. Rate limiting of failed
logins isn't set up (Envoy Gateway's rate limit needs its global Redis-backed limiter;
not cheap here).

**Passwords**: `$HOME/.config/director-editor/internal-tools.txt` (mode 600), written to
be pasted to the team as is: every URL with its logins. The shared login, Grafana's and
the Stalwart admin's passwords are also SOPS-encrypted in
`deploy/platform/secrets/production/` (internal-tools-auth, grafana, stalwart). Argo CD's
is its `argocd-initial-admin-secret`; RustFS's keys are the cluster's generated Secrets.

Also live: Loki (single binary, 20 Gi local-path PVC, 30 days), Alloy (DaemonSet, reads
pod logs through the API, labels `namespace`, `pod`, `container`,
`app_kubernetes_io_component`), observability label on (services export traces and
metrics), Kyverno image-signature policy back on, Kyverno admission at 1 with the
cleanup and reports controllers removed, one Envoy proxy, Argo CD's server on plain HTTP
behind the gateway. Node requests: CPU 47% of 8, memory 34% of 32 GB.

## Playwright results (`playwright-cli -s=ops`, Chromium, production URLs)

Screenshots in `screenshots/ops/`.

- Without the password every host answers 401 with a Basic challenge (browser:
  `ERR_INVALID_AUTH_CREDENTIALS`, `00-grafana-without-password.png`); a wrong password
  also 401; the right one gets the tool. On storage./backups. the bare host without
  credentials answers RustFS's own 403 (an unsigned S3 call), and `/rustfs/console` 401.
- Grafana: signed in as admin; "Kubernetes / Compute Resources / Cluster" with series
  for every namespace (`01-grafana-cluster-dashboard.png`).
- Loki: `{namespace="director-editor", app_kubernetes_io_component="api"} |= "trace_id"`
  returns the api's JSON lines (`02-grafana-loki-api-logs.png`); each line has "Trace in
  Jaeger" (`03-…`), which opens the trace in Grafana's Jaeger data source (`04-…`).
- Jaeger: services api, worker, ai-worker, jaeger; 9 api traces in the last hour
  (`05-jaeger-api-traces.png`); a trace page has "Logs in Grafana" (`06-…`) which opens
  Loki's lines for that trace id (2 lines, `07-logs-from-jaeger-trace.png`).
- Prometheus: CPU by namespace graph with director-editor (`08-prometheus.png`); 16
  targets up; the services' OTLP metrics arrive (target_info per service).
- Alertmanager: active alerts incl. Watchdog (`09-alertmanager.png`).
- Argo CD: signed in as admin, the applications list (`10-argocd.png`).
- Stalwart admin: signed in as admin@director.mmadan.in, the Accounts page lists admin
  and no-reply (`11-stalwart-admin.png`).
- RustFS backups console: signed in with the backups server's keys; bucket `backups`, 42
  objects, 13.2 MiB (`12-rustfs-backups-console.png`). Uploads console: bucket `uploads`,
  empty, since production keeps media in GCS (`13-rustfs-uploads-console.png`).

## How it got to the VM before a release (bridge)

The ApplicationSets read add-ons at production's release revision (v1.0.0), so:
- New things are **bridge Applications** with exactly the names the ApplicationSets will
  generate, reading the branch: `production-loki`, `production-alloy` (project `default`
  until the `platform` project lists Grafana's repository) and
  `production-internal-tools`, labelled `director-editor.dev/bridge=true`. The
  ApplicationSet adopts an existing Application by name (sets itself owner, rewrites the
  spec), so after the release they're ordinary generated ones.
- Existing Applications were synced **to the branch's revision without changing their
  spec** (`argocd app sync --revisions … --source-positions …`): platform-secrets,
  kyverno, platform-config, mail, data, kube-prometheus-stack, jaeger, alerts. They show
  "OutOfSync from v1.0.0" until the release; nothing reverts them meanwhile because
  RollingSync keeps auto-sync off. Jaeger's link needed one server-side apply with Argo
  CD's field manager (log step 10).
- The label flip and Argo CD's server.insecure went through `tofu apply`, the documented
  way; its plan touched only the cluster Secret and the Argo CD helm release (log step 6).
  production.tfvars (out of git, main checkout) now says `observability = true` and
  e2-standard-8.

## What's in the branch

Commits (all mine, author Manas Madan <manasmadan08@gmail.com>):

1. `fix(infra): let every Application sync and heal on its own`: drops RollingSync and
   waves from envs/platform/observability; automated + self-heal + `retry.limit: -1`.
2. `feat(infra): keep every pod's logs in Loki, linked to the traces`: Loki and Alloy
   add-ons with values, Grafana's Loki/Jaeger data sources (uids `loki`, `jaeger`,
   derived field on `traceId`/`trace_id`), sidecar on every namespace, Jaeger's
   "Logs in Grafana" link, Grafana's chart repo in the platform project.
3. `feat(infra): put the operators' tools on their own hosts behind basic auth`: new
   `deploy/platform/internal-tools` chart + add-on, mail chart web admin (account,
   Service, network policy), data chart RustFS consoles, Argo CD server.insecure, the
   new SOPS secrets.
4. `fix(infra): give Alloy only the access reading pod logs needs` (Trivy KSV-0041).
5. `chore(infra): run one Kyverno admission controller and one gateway proxy` (also the
   Kyverno CRD label that kept it OutOfSync).
6. `feat(infra): file Grafana's dashboards in the folder they name` (folderAnnotation
   grafana_folder, for the activity-logging dashboards).
7. `feat(infra): send each internal host's bare address to its tool's page` (+ replaced
   the basic-auth password, see concerns).
8. `fix(repo): keep the pre-push hook's tests out of the real repository`: the GIT_* leak
   (below).
9. Five fixes to the internal routes found by the browser checks (Stalwart's /jmap and
   /api, explicit route defaults, RustFS's signed API calls, navigation-only redirect).
10. `test(repo): check every ApplicationSet syncs and heals on its own`.
11. `docs(infra): describe the internal tools, the logs and the 32 GB production machine`.

Checks: `bun run charts:check` passes; `bun scripts/misconfig.ts` (Trivy) passes;
`bun run infra:check` passes; `bun test ./scripts/` 799 pass (after generating the Prisma
client in the worktree); hook tests pass; biome and `tsc -p scripts` clean. I didn't run
the full `bun run lint` or the browser suites.

## The brief's other items

- **Stale S3_*/STORAGE_ORIGIN fields**: production-stack's very first sync (2026-10-17
  13:14, user `claude`, from branch fix/mm/argocd-first-sync) was a server-side apply;
  every later sync is client-side. managedFields show `argocd-controller Apply` next to
  `argocd-controller Update`. The first client-side apply had no last-applied annotation
  to diff, so fields the server-side apply set and later values dropped were never
  removed. Documented in deploy/README.md "Troubleshooting" (how to spot and remove, and
  never sync data/stack with the server-side option), plus a comment in envs.yaml.
- **automated.enabled: false** on every generated Application (not just four): Argo CD
  v3.5's RollingSync forces it and syncs only on revision/spec changes; it also stalled
  production's platform rollout at Kyverno (perpetual `labels: {}` diff), so mail and
  platform-config never got v1.0.0, which is why mail-0 broke after the VM restart.
  Re-enabling by hand isn't possible while RollingSync is on (the ApplicationSet
  controller reverts it). The branch removes RollingSync; **auto-sync comes back for all
  of them, the stack included, as soon as the branch is merged** (root syncs
  deploy/argocd from master's head). Nothing for the controller to do by hand.
- **VM size**: infra/tofu/README.md, production stack.yaml and data.yaml comments,
  docs/architecture.md, production.tfvars (local).
- **Image-signature policy**: all seven production images verified with cosign against
  the policy's identity, then re-enabled; a signed image is admitted (rewritten to its
  digest) and an unknown tag refused (server dry runs). The cluster annotation had been
  set to "false" by hand; tofu's state said true, and the apply put it back.
- **GIT_* test leak**: `withoutGitRepository` in scripts/lib.ts strips the variables
  `git rev-parse --local-env-vars` lists from every pre-push step; a test proves a GIT_DIR
  in the hook's environment doesn't reach `git init`; .claude/hooks/lib.test.ts and
  statusline.test.ts drop them too. The "t"-authored commits were rewritten and
  force-pushed.

## Concerns and what's left

1. **Merge then promote right away.** On merge, root applies the new ApplicationSets and
   every Application auto-syncs to its target, still v1.0.0 until the promotion: Kyverno
   back to 3 replicas, Envoy to 2, kube-prometheus-stack/jaeger/mail/data/secrets back to
   v1.0.0 (Loki data source, sidecar, consoles, web admin, internal-tools-auth gone for
   that window; Kyverno's labels diff makes it re-sync in a loop). The bridges keep
   reading the branch; if it's deleted after the merge they show a comparison error but
   keep their resources. After the promotion the ApplicationSets adopt the bridges.
   Delete the bridge label afterwards if you like; nothing depends on it.
2. **The activity-logging branch's dashboards add-on** (deploy/platform/dashboards): the
   sidecar already watches every namespace with `folderAnnotation: grafana_folder`, and
   the data source uids are `loki` and `jaeger`. If it's an observability add-on it needs
   no ordering now (no waves). Not applied on the VM.
3. **RustFS's S3 API is reachable on storage./backups. behind the servers' keys alone**:
   the console signs its calls with the keys in Authorization, which basic auth can't
   pass through, so only `/rustfs/console` asks for the shared password. The backups
   server had no route before. If that's too much, drop `backups` from the internal tools
   (`tools.backups.enabled: false`) and use its console through a port-forward.
4. **Stalwart's `/jmap` and `/api`** likewise skip basic auth (bearer tokens); they need
   Stalwart's own login (anonymous `/jmap/session` only lists capabilities).
5. **Password rotation**: a check script of mine printed one redirect URL that contained
   the shared login into my own tool output, so I replaced that password before
   finishing; the file and the SOPS secret have the new one.
6. **Firewall**: I added my address 49.205.41.153/32 to `director-admin` (22, 6443) to run
   tofu; remove it when you're done.
7. **Loki label name** is `app_kubernetes_io_component` (Loki can't take dots/slashes);
   the app's pods have no component label, so it carries their `app.kubernetes.io/name`
   (api, worker, ai, ...). The activity-logging agent should query that name.
8. Argo CD's `url` setting is still the chart's argocd.example.com (only matters for SSO
   and notification links); I left it out of scope.
