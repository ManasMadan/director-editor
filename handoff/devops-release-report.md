# DevOps release report

PR: https://github.com/ManasMadan/director-editor/pull/13
Branch: `chore/mm/devops-release` (from origin/master), head `f4bb167`, not merged.
Title: `chore(infra)!: observability, internal tools, activity logs and production fixes`

## CI

All green on `f4bb167`: 45 pass, 6 skipped (path-gated), 0 failing. CI passed, Security
passed, Kubernetes passed and Infrastructure passed all report success. No jobs were
re-run.

## What's in it

Merges (each `--no-ff --no-verify`):
- `chore(infra): merge production observability and internal tools`
- `feat(repo): merge activity logging and its Grafana dashboards`. It conflicted in
  `scripts/charts.ts` and `scripts/charts.test.ts`. I kept both sides: internal-tools and
  dashboards are both in OWN_CHARTS, and the test counts `platformRenders(root)`.
- `fix(api): merge the demo account's hashing fix`

Follow-up commits:
- `fix(infra): give the backups server's console no public host`:
  - `tools.backups.enabled: false` is the default, with unittest cases for off and on.
  - deploy/README.md documents the port-forward instead
    (`kubectl -n director-editor port-forward svc/director-editor-backups 9001:9001`).
  - The data chart's comment is updated. `storage.` stays for the uploads console.
- `fix(infra): sync the dashboards with no wave, ...`:
  - I dropped `wave: "10"` from the dashboards add-on, since appsets.test.ts refuses
    waves now that progressive sync is gone.
  - docs/observability.md now names Alloy's labels (including
    `app_kubernetes_io_component`), the `loki` and `jaeger` uids,
    `deploy/platform/internal-tools` and its `internal-tools-auth` Secret, and links
    deploy/README.md "Internal tools".
  - The dashboards already matched: the Loki data source variable, the Jaeger uid
    `jaeger`, the `grafana_folder` annotation, and no component-label queries.
- `chore(infra): codify production's indexer, Director model and machine size`:
  - The ai-worker sets `INDEXER_URL`, and the comment is updated.
  - `DIRECTOR_MODEL=gemini-3.8-flash` is set in `secrets/ai.sops.yaml` (key path
    `stringData`) with `sops set`. No value was printed.
  - docs/deploy.md, infra/tofu/README.md and deploy/README.md say e2-standard-8
    (8 vCPUs, 32 GB) and about $210 a month. None of them had the cost before.
- `style(infra): format the mail chart's schema` (biome).
- Fixes for the first CI run:
  - logger: CodeQL found a polynomial ReDoS in the query-parameter scrub. The pattern
    is now linear, with a test.
  - Coverage: added tests for the admin's activity lines (create-user and impersonate),
    a coded job failure, and the auth CLI's no-op activity sink.
  - Loki is pinned to 3.6.18, which scans clean, with a Renovate comment.
    renovate.json5's comment manager now reads `deploy/platform/values/*.yaml`.
  - `.trivyignores/grafana/alloy.yaml` holds 4 CVEs, expiring 2026-11-17. v1.20.1 is
    the latest Alloy.
  - The KSV-01010 exception is extended to `platform-dashboards.yaml`, whose ConfigMaps
    hold dashboard queries and no secrets.

Checks run locally on the final head: lint (only the image-scan.test.ts warning that's
also on master), check-types, test, scripts and hooks tests (985 pass), charts:check, and
gen (no drift). The touched integration tests also pass: job-processor and api activity.
I didn't run any browser suites.

## Left for the controller

- Merge, then promote production right away (see the ops report). Merging switches every
  Application to auto-sync at v1.0.0 until the promotion.
- After the promotion, check that the `backups.` route and its SecurityPolicy are gone.
  The bridge `production-internal-tools` Application reads the old branch until the
  ApplicationSet adopts it.
- From the ops report, still open: remove 49.205.41.153/32 from the `director-admin`
  firewall, and set Argo CD's `url` (it's still argocd.example.com).
- The Alloy exceptions expire on 2026-11-17. Move to v1.21 once it's released.
