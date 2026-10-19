# Production internal tools and observability (VM first, then one devops PR)

The owner wants every internal tool running in production, each on its own password-protected page,
plus proper log aggregation. Production is one GCE VM (`director-1`, us-central1-a, project
`project-18e15b18-c92e-44bb-9bf`, now e2-standard-8: 8 vCPU / 32 GB) running k3s with Argo CD. Reach it
with `gcloud compute ssh director-1 --zone us-central1-a --project project-18e15b18-c92e-44bb-9bf --command "sudo k3s kubectl ..."`.
The site is https://director.mmadan.in and must stay up throughout: never delete a PVC, the database,
or anything in the `director-editor` namespace's data.

## Order (owner's rule)

1. Make it all work on the VM first.
2. Test every page with Playwright (`playwright-cli -s=ops open --browser=chromium <url>`). Check the
   page refuses without the password, works with it, and shows real data (Grafana dashboards with
   series, Loki with app logs, Jaeger with traces from the services, Argo CD apps, the Stalwart admin, the
   RustFS console).
3. Only then codify everything in the repo, on branch `chore/mm/prod-observability` (from origin/master),
   so a fresh cluster built from the repo gets the same. Don't open the PR: the controller merges other
   work into this branch first and opens it.

## What to turn on and expose

- Observability: Prometheus, Alertmanager, Grafana (kube-prometheus-stack) and Jaeger already exist in
  the repo (`deploy/platform/addons/observability`, `deploy/platform/values/kube-prometheus-stack.yaml`,
  `deploy/platform/jaeger`), switched off for production. They're switched by the Argo CD cluster
  Secret's label `director-editor.dev/observability` (`deploy/argocd/appsets/*.yaml`), which OpenTofu
  writes from `var.observability` (`infra/tofu/envs/k3s`). On the VM, flip the label; in the repo, the
  production tfvars or the equivalent (read how production's tofu inputs are kept; don't run `tofu apply`
  unless it's the documented way and its plan only touches this). Alertmanager needs `alert_email`: use
  manasmadan08@gmail.com.
- Logs: add Loki (single binary, filesystem on a PVC, 30-day retention) and a collector (Grafana Alloy
  or Promtail as a DaemonSet) shipping every pod's logs with labels `namespace`, `pod`, `container`, and
  `app.kubernetes.io/component`. The services log JSON with pino (Node) and the app's log module (Python),
  with `traceId` in each line where there is one: set Grafana's Loki data source to link `traceId` to Jaeger,
  and Jaeger to Loki. Add it as an Argo CD add-on the same way the others are, with its values file.
- Expose, each on its own host under `director.mmadan.in` (pick names like `grafana.`, `argocd.`,
  `jaeger.`, `prometheus.`, `alertmanager.`, `loki.` if it has a UI worth it (else skip), `mail-admin.`,
  `storage.`), through the existing Envoy Gateway and the same DNS/TLS path `files.director.mmadan.in` uses
  (read how that host gets its DNS record and certificate, and follow it exactly).
- Password protection: an Envoy Gateway `SecurityPolicy` with basic auth on every internal host, one
  shared admin user. Tools with their own login keep it too (Argo CD admin, Grafana admin, Stalwart
  admin, RustFS console). Generate strong passwords. Store them encrypted in the repo's SOPS secrets
  the way the others are (`SOPS_AGE_KEY_FILE=$HOME/.config/director-editor/production.agekey`, the
  `deploy/environments/production/secrets` layout), and write the plain values for the owner to
  `$HOME/.config/director-editor/internal-tools.txt` (mode 600, outside the repo). Never print a password in
  your output or report; say where it is.
- Keep every component at 1 replica (owner's rule for this prototype), and right-size CPU and memory
  requests so the node isn't over-requested (the last deploy stalled with requests at 98% of 4 vCPU).
  Include the changes the controller already made by hand: Kyverno admission controller at 1 replica,
  the Kyverno reports and cleanup controllers scaled to 0 (decide: keep at 0 or 1 with small requests),
  Envoy's public proxy at 2 replicas should be 1.

## Also in the same PR (the controller fixed these by hand on the VM; codify or document each)

- Live Deployments kept stale `S3_*` env vars and a `STORAGE_ORIGIN` `valueFrom` from earlier applies
  that Argo CD's server-side apply didn't remove (api and worker crashed: "S3_BUCKET is set but
  STORAGE_PROVIDER is gcs"; web's sync failed on env[3].valueFrom). The controller removed them with
  kubectl. Find why Argo didn't prune them (field managers: a `kubectl` or client-side-apply manager from
  earlier hand edits, most likely) and fix it so it can't recur, or document it in deploy/README.md's
  troubleshooting.
- Several platform Applications (kyverno, mail, platform-config, stack) have `automated.enabled: false` in
  the cluster though the appsets say automated: find why, re-enable auto-sync on the VM once things are
  healthy, and make sure the repo matches.
- The VM is now e2-standard-8 (owner approved, ~$210/month): update the docs that state the size and the
  16 GB budget (docs/deploy.md, infra/tofu/README.md, deploy/README.md, anything else).
- Re-enable the Kyverno image-signature policy if it's safe (images are signed by deploy.yml on master,
  including workflow_dispatch runs); check every running image passes first.

## Working rules

Read CLAUDE.md, .claude/rules/infra.md, ci.md and docs.md. Commits: `--no-verify`, Conventional with a
workspace scope (`chore(infra): …`), first person, never mention AI/Claude/co-authors. Never `git stash`.
Run `bun run charts:check` (background) and the lint for what you touch. Keep an ordered log of every
change you make in the cluster in
/Users/manas.madan/Desktop/code/director-editor/.superpowers/sdd/2026-10-18-director-hackathon/ops-cluster-log.md
(command, why, result), and your final report in task-ops-report.md next to it: what's live, each URL,
the Playwright results with screenshot paths, where the passwords are, the branch and commits, and
anything left.

Another agent is adding structured activity logging to the app code at the same time (branch
`feat/mm/activity-logging`); it will query Loki with the labels above and JSON fields, and ship Grafana
dashboards as ConfigMaps labelled `grafana_dashboard: "1"`. Make sure Grafana's dashboard sidecar picks
those up from every namespace.
