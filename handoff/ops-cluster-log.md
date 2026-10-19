# Production cluster change log (ops task: internal tools and observability)

Every change made in production (`director-1`, project `project-18e15b18-c92e-44bb-9bf`), in
order: command, why, result. `k` is `gcloud compute ssh director-1 --zone us-central1-a
--project project-18e15b18-c92e-44bb-9bf --command "sudo k3s kubectl ..."`. `argocd` is the
argocd CLI run inside the `argocd-server` pod, logged in as admin. "The branch" is
`chore/mm/prod-observability` on GitHub.

## 1. Mail server stuck after the VM resize (09:31 UTC)

- **Command**: `k -n mail delete pod mail-0`
- **Why**: after the VM restart for the resize, `mail-0` restarted in place with its
  `provision` emptyDir intact. The `recovery` sidecar found the old `stopped` marker, never
  started Stalwart's recovery server, and its startup probe on 8080 failed forever (0/2,
  killed every 3 minutes for 20+ minutes: no mail, so no sign-in codes). v1.0.0 already
  clears the markers in the `plan` init container, but production-mail had never synced
  v1.0.0 (see 3). The PVC `data-mail-0` was untouched.
- **Result**: the new pod came up 2/2 within 30 s.

## 2. Diagnosis only (no change)

- All 12 generated Applications had `automated.enabled: false`: Argo CD's RollingSync
  (progressive sync) forces that on every Application it generates and syncs them only on a
  revision or spec change (argo-cd v3.5.4 `applicationset/progressivesync`). So nothing
  self-heals, and a re-enable by hand is reverted by the ApplicationSet controller.
- The platform rollout was stuck at step 2 since 08:58: production-kyverno never reports
  Synced (11 policies.kyverno.io CRDs: the chart renders `labels: {}`, which the API server
  drops), so steps 4 and 5 (platform-config, mail) sat in Waiting and never got v1.0.0.
- Stale S3_* / STORAGE_ORIGIN fields: production-stack's first sync (2026-10-17 13:14, user
  `claude`, from branch fix/mm/argocd-first-sync) was a server-side apply; every later sync
  is client-side. The managedFields show `argocd-controller Apply` (13:14) next to
  `argocd-controller Update`: the first client-side apply had no last-applied annotation to
  diff against, so fields from the server-side apply that later values dropped were never
  removed.

## 3. Bridge Applications for what's new (10:57 IST / ~09:57 UTC)

- **Command**: `k apply -f bridge-observability.yaml` (production-loki, production-alloy)
  and later `k apply -f bridge-internal-tools.yaml` (production-internal-tools).
- **Why**: the observability and platform ApplicationSets read add-ons at production's
  release revision (v1.0.0), which doesn't have them. These Applications have exactly the
  names, namespaces, release names and values the ApplicationSets will generate once a
  release carries the branch, but read the branch (`targetRevision:
  chore/mm/prod-observability`), auto-sync with self-heal, and carry the label
  `director-editor.dev/bridge: "true"`. Loki and Alloy are in the `default` project, since
  the `platform` project only lists Grafana's chart repository after the merge. The
  ApplicationSet adopts an existing Application of the same name (it sets itself as owner
  and overwrites the spec), so after the release they become ordinary generated ones.
- **Result**: Loki (`loki-0`), Alloy (one DaemonSet pod), the internal routes and their
  SecurityPolicies and ReferenceGrants are up; all three Synced/Healthy.

## 4. Existing Applications synced to the branch (no spec change)

Each with `argocd app sync <app> --revisions <rev> --source-positions <n>`: Argo CD applies
the branch's render with its own field manager while the Application's spec stays at
v1.0.0. They show "OutOfSync from v1.0.0" until the release; with auto-sync forced off by
RollingSync nothing reverts them meanwhile.

| When (UTC) | Application | Revisions | Why | Result |
|---|---|---|---|---|
| 09:59 | production-platform-secrets | branch | grafana-admin, alertmanager-smtp (observability), internal-tools-auth (gateway-system), stalwart's WEBADMIN_PASSWORD | Succeeded |
| 09:59 | production-kyverno | 3.9.1 + branch, with prune | admission controller 3 to 1, cleanup and reports controllers removed (pruned with their RBAC, Services, the admission PDB), CRD label | Succeeded; 2 Kyverno pods left |
| 10:01 | production-platform-config | branch | Envoy proxy 2 to 1 | Succeeded; 1 proxy pod |
| 10:01 | production-mail | branch | web admin account, `mail-admin` Service, network policy for the gateway on 8080 | Succeeded; mail-0 2/2 after 27 s |
| 10:03 | production-data | branch, no prune | RustFS consoles on 9001 (uploads, backups): env, Service port, network policy | Succeeded; both RustFS pods restarted, bucket Jobs passed; Postgres untouched |

## 5. Firewall: my address for the Kubernetes API (10:05 UTC)

- **Command**: `gcloud compute firewall-rules update director-admin --source-ranges
  49.205.46.74/32,49.205.41.153/32`
- **Why**: `tofu plan` timed out on 35.208.116.112:6443; the rule allowed only the owner's
  earlier address. infra/tofu/README.md says 22 and 6443 must be open from where OpenTofu
  runs. I added my current address and kept the old one. Remove 49.205.41.153/32 when you
  no longer need it.
- **Result**: plan ran.

## 6. OpenTofu apply (the documented way), ~10:06 UTC

- **Command**: from the branch's checkout, with production.tfvars changed to
  `observability = true` (and its comment to e2-standard-8): `tofu plan -out`, then `tofu
  apply` of that plan. The same tfvars change is in the main checkout's
  infra/tofu/envs/k3s/production.tfvars (kept out of git).
- **Plan**: `0 to add, 2 to change, 0 to destroy`: the cluster Secret (label and annotation
  `director-editor.dev/observability` false to true, and `director-editor.dev/image-policy`
  back to the state's `true`, since someone had set it to "false" in the cluster) and the
  Argo CD helm release, whose only values change was `configs.params.server.insecure: true`.
- **Why**: the label turns on observability (the observability ApplicationSet and the
  stack's OTLP export); server.insecure lets the gateway reach Argo CD over plain HTTP.
- **Result**: applied; a second plan says "No changes". The observability ApplicationSet
  generated production-kube-prometheus-stack, -jaeger, -alerts at v1.0.0 and RollingSync
  synced them; the envs ApplicationSet re-synced production-stack (observability.enabled
  true), so every service restarted once with OTEL_EXPORTER_OTLP_ENDPOINT,
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT and ALERTMANAGER_URL (10:09). The ai worker's
  INDEXER_URL (set with kubectl-set) survived: client-side apply leaves fields that aren't
  in the last-applied annotation. Site checks: /healthz 200, /api/v1/system 200.

## 7. Image signatures (10:13 UTC)

- **Checks first**: `cosign verify` of every production image (ai, api, migrate,
  notifications, web, webhooks, worker at sha-588258109e…) against the policy's identity
  (`.github/workflows/*@refs/heads/master`, GitHub's OIDC issuer): all signed.
- **Command**: `argocd app sync production-platform-config --revisions <branch>
  --source-positions 1` (its spec now has imagePolicy.enabled=true from the cluster
  annotation).
- **Result**: ClusterPolicy `verify-image-signatures` is back. A server dry-run of a pod
  with the signed web image is admitted (image rewritten to its digest); one with an
  unknown tag is refused by `signed-by-ci`.

## 8. Observability Applications synced to the branch

| When (UTC) | Application | Why | Result |
|---|---|---|---|
| 10:15 | production-kube-prometheus-stack (91.7.1 + branch) | Loki and Jaeger data sources linked by trace id, the dashboard sidecar watching every namespace | Succeeded |
| 10:16 | production-jaeger | the "Logs in Grafana" link on each trace | Succeeded |
| 10:16 | production-alerts | the branch's revision, like the others | Succeeded |
| 10:25 | production-kube-prometheus-stack again | the sidecar files dashboards by their grafana_folder annotation | Succeeded |

## 9. Basic-auth password replaced (10:30 UTC)

- **Command**: new password in deploy/platform/secrets/production/internal-tools-auth.sops.yaml
  (pushed), then `argocd app sync production-platform-secrets --revisions <branch>
  --source-positions 1`.
- **Why**: a check script of mine printed a redirect URL with the credentials in it to my
  own log; I replaced the password rather than keep one that had been printed.
- **Result**: old password refused, new one accepted on every host.

## 10. Jaeger's "Logs in Grafana" link (10:40 UTC)

- **Command**: `helm template` of the branch's deploy/platform/jaeger with production's
  cluster values (`domain=mmadan.in`, `directZone=director.mmadan.in`), Argo CD's
  tracking annotation added, then `k apply --server-side --field-manager=argocd-controller
  --force-conflicts` of the ConfigMap and Deployment `jaeger`.
- **Why**: the sync in 8 used the generated Application's v1.0.0 parameters, which have no
  domain (the jaeger add-on's clusterParameters arrive with the release), so no link was
  rendered. Applied with Argo CD's own field manager and tracking id, so the release's
  sync takes these fields over cleanly.
- **Result**: each trace page in Jaeger has "Logs in Grafana", opening Loki's lines for that
  trace id.

## 11. Internal routes fixed through the bridge (10:38 to 11:00 UTC)

Pushed to the branch; production-internal-tools (bridge, auto-sync) applied each:
- `/jmap` and `/api` on mail-admin left to Stalwart's own sign-in (its page then got 401s
  from basic auth on its bearer-token calls).
- Defaults written out in the routes (Argo CD showed them OutOfSync forever).
- On storage./backups. only `/rustfs/console` behind basic auth; RustFS's signed S3 and
  admin calls go to the server (its sign-in got 401 from basic auth).
- The bare-host redirect only for browser navigations (it caught `GET /?x-id=ListBuckets`).
- **Result**: production-internal-tools Synced/Healthy; every page works (see the report).

## State at the end (11:05 UTC)

- All pods Running. Node requests: CPU 3815m of 8 (47%), memory 11152Mi of 32 GB (34%).
- Applications: Synced/Healthy: alerts, alloy, cert-manager, cloudnative-pg,
  envoy-gateway, external-dns, internal-tools, keda, loki, plugin-barman-cloud, stack.
  "OutOfSync from v1.0.0" (live is the branch's render, on purpose, until the release):
  data, jaeger, kube-prometheus-stack, kyverno, mail, platform-config, platform-secrets.
- Every generated Application still has `automated.enabled: false` (RollingSync). That
  ends when the branch's ApplicationSets reach master (root syncs deploy/argocd from
  master's head).
- Firewall rule director-admin has my address 49.205.41.153/32 added (remove when done).
- Bridge Applications (label director-editor.dev/bridge=true): production-loki,
  production-alloy, production-internal-tools, reading chore/mm/prod-observability.
