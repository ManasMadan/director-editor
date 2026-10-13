# Deploying

Everything runs on k3s on machines you run (one node or several; `infra/tofu` sets
them up), and on kind locally, from the same charts. Nothing is a managed service:
Postgres, Valkey, object storage, mail and observability all run in the cluster.
Cloudflare stays in front (DNS, proxy, WAF), and third-party APIs (AI models, Twilio,
APNs/FCM, Stripe, Google, Turnstile) stay external.

```
deploy/
  docker/          one Dockerfile per kind of image (docker-bake.hcl builds them all)
  charts/stack     the application: every service from one values file
  charts/data      Postgres (CloudNativePG), Valkey, RustFS, and their credentials
  environments/    values per environment (local, preview, staging, production) and
                   each one's encrypted Secrets (secrets/)
  platform/        cluster add-ons (addons/, values/), our own platform charts
                   (config/, mail/, jaeger/) and the add-ons' encrypted Secrets (secrets/)
  argocd/          the root Application, projects, ApplicationSets, and the values
                   Argo CD itself is installed with (argo-cd-values.yaml)
  local/           what kind needs besides the charts (bun run k8s:up)
```

`bun run charts:check` lints every chart of ours and runs its unit tests, renders the
application for every environment and the platform, validates all of it against
Kubernetes and the CRDs it uses, renders every add-on at its pinned version with our
values, and refuses any file in a `secrets/` directory that isn't SOPS-encrypted. The
schemas kubeconform validates against are downloaded once into
`node_modules/.cache/kubeconform` (CI caches that directory too).

## One app per cluster

The names are fixed, not derived from the project: the namespaces `boilerplate`,
`pr-<number>` and `mail`, the ApplicationSets `envs`, `previews`, `platform` and
`observability`, the gateway `public`, the `boilerplate.dev/*` labels and annotations on
clusters, OpenTofu's `boilerplate-<env>` names, and kind's cluster and image builder
(`boilerplate`, `scripts/k8s.ts`). So each cluster runs one app built from this template,
per environment: a second app on the same cluster would share the namespaces and
ApplicationSets with the first. Give each app its own clusters. Locally, docker compose's
project is `boilerplate` too (`docker-compose.yml`), so one checkout's services run on a
machine at a time.

## Two releases per environment

`data` and `stack` are separate releases in the same namespace, `data` first. The
stack's migration Job runs before its services (a Helm pre-install/pre-upgrade hook,
an Argo CD PreSync hook), so the database must already be up. Keeping it in its own
release is what guarantees that, and it means redeploying the application never touches
the database. The migration Job runs on every sync of the stack, a self-heal included,
not only when there's a new migration: `prisma migrate deploy` with nothing new to apply
changes nothing, so a rerun costs one short-lived pod and a line in Argo CD's history.

## How every pod runs

Every container of both charts, and of the platform's own (`platform/mail`,
`platform/jaeger`, `platform/alerts`), runs as user and group 10001 (never root, never an id of
the node's own users), on a read-only root filesystem with every capability dropped,
writing only to its volumes and an empty `/tmp`, and with a CPU limit as well as a
memory one: a busy or runaway process slows itself down rather than its node's other
pods. The limits are in each chart's `values.yaml` (`defaults.resources` for the
services, one CPU each; two for ClamAV and Postgres), and an environment's values
override them. Every object names its release's namespace. ClamAV starts itself rather
than through its image's entrypoint, which needs root's rights over its own files: each
new pod fetches the signatures (about 110 MB, from database.clamav.net) before it takes
connections, then keeps them current. `bun scripts/misconfig.ts` renders every chart of
ours (the application's for every environment, the platform's with a cluster's values)
and fails on any setting Trivy finds that breaks these rules.

## Network policies

Each environment's namespace accepts nothing a policy doesn't allow (the data chart's
default deny). Each service accepts connections from the gateway if it has routes, and
from the services and namespaces its `allowFrom` and `allowFromNamespaces` name. It
connects only to DNS, its own namespace (the other services, Postgres, Valkey, object
storage, ClamAV), the mail server's and the telemetry namespaces
(`networkPolicy.egressNamespaces`), ServiceLB on the gateway's and mail ports, and the
internet outside the private ranges: so a request forged to reach something internal,
another environment's namespace, a node or a metadata address goes nowhere. Postgres
takes connections from its own namespace, CloudNativePG's operator and the metrics
scraper only, so a preview can't reach staging's database. The mail server takes
connections on its mail ports only; its management port is reachable from inside its
pod alone. The data services' own pods and the Jobs (migration, buckets, offsite copy)
aren't limited in where they connect.

## Postgres over TLS

Postgres refuses connections without TLS (`hostnossl … reject` in the data chart).
CloudNativePG serves TLS with a certificate authority of its own, the `<cluster>-ca`
Secret; the stack mounts it in every service with a database (`database.caSecret`) and
adds `sslmode=verify-full` and the CA's path to the URL from the role's Secret, so the
services check they're talking to this cluster's Postgres. The migration Job uses the
Secret's URL as it is: Prisma's migration engine negotiates TLS, since Postgres requires
it, but doesn't check the certificate.

## Credentials: generated, or in git encrypted

There are two kinds of secret, and each has one home:

- **Only the cluster needs them**: the database roles' passwords, Valkey's, the object
  storage keys. The data chart generates them in the cluster the first time it's
  installed: a Job, before anything else of the release, creates each Secret with
  random values unless it already exists. Its role may only create Secrets, so it can't
  read or change one, and no password ever changes under a running database. They're
  never in git and nobody needs to know them. After a restore into a new cluster, the
  new ones are set on the restored roles (see Backups).
- **Everything else** (auth and encryption keys, API keys, the mail server's and
  Cloudflare's credentials): committed to this repository encrypted with SOPS and age,
  and decrypted by Argo CD into the cluster. They must survive the cluster (losing
  `ENCRYPTION_KEYS` makes stored data unreadable), come from outside it, or both.

| Secret | Keys | From |
|---|---|---|
| `db-<role>` for `migrator`, `app_api`, `app_worker`, `app_notifications`, `app_webhooks`, `app_ai` | `username`, `password`, `url`, `directUrl` | generated (data chart) |
| `valkey` | `host`, `port`, `password`, `url` | generated (data chart) |
| `storage` | `bucket`, `region`, `endpoint`, `publicEndpoint`, `accessKeyId`, `secretAccessKey` | generated (data chart) |
| `<release>-backups-storage` | `accessKeyId`, `secretAccessKey` (the backups server's) | generated (data chart) |
| `<release>-<service>` for `api`, `notifications`, `webhooks`, `ai` (the AI worker shares `ai`'s; `web` and `worker` have none) | any of the service's variables (each app's `src/env.ts`, `app/settings.py` for ai) | `environments/<env>/secrets/<service>.sops.yaml` |
| `offsite-storage`, where there's an offsite copy (production) | `accessKeyId`, `secretAccessKey` of the storage outside the cluster | `environments/<env>/secrets/offsite-storage.sops.yaml` |
| `cloudflare-api-token` in `cert-manager` and in `external-dns`, with Cloudflare DNS | `token` (Zone:DNS:Edit on the zone) | `platform/secrets/<env>/` |
| `rfc2136-tsig` in `cert-manager`, with DNS of your own (RFC 2136) | `secret` (the TSIG key, base64) | `platform/secrets/<env>/` |
| `external-dns-rfc2136` in `external-dns`, likewise | `host`, `zone`, `tsig-keyname`, `tsig-secret`, `tsig-secret-alg` | `platform/secrets/<env>/` |
| `github-token` in `argocd`, on the cluster hosting previews | `token` (reads pull requests) | `platform/secrets/<env>/` |
| `argocd-notifications-secret` in `argocd`, on the cluster hosting previews | `github-appID`, `github-installationID`, `github-privateKey` (the repository's GitHub App, with Pull requests: write: it posts each preview's address) | `platform/secrets/<env>/` |
| `stalwart` in `mail` | `ADMIN_PASSWORD`, `SMTP_PASSWORD`, `STALWART_WEBHOOK_SECRET`, `dkim.key` (see `platform/mail/values.yaml`) | `platform/secrets/<env>/` |
| `grafana-admin` in `observability`, only on clusters with observability (its namespace exists nowhere else) | `admin-user`, `admin-password` | `platform/secrets/<env>/` |
| `alertmanager-smtp` in `observability`, likewise | `password` (the mail server's `SMTP_PASSWORD`, which Alertmanager sends alerts with) | `platform/secrets/<env>/` |

What each service's Secret holds, at least:

- `api`: `BETTER_AUTH_SECRET`, `ENCRYPTION_KEYS`, `UNSUBSCRIBE_SECRET`,
  `AI_SERVICE_SECRET`; and whatever it uses of `GOOGLE_CLIENT_*`, `TURNSTILE_*`,
  `STRIPE_*`, `VAPID_PUBLIC_KEY`.
- `notifications`: `UNSUBSCRIBE_SECRET` (the api's), `SMTP_URL` =
  `smtps://no-reply%40<email domain>:<SMTP_PASSWORD>@<mail host>:465` (the mail
  server's submission account); and `TWILIO_*`, `FCM_*`, `APNS_*`, `VAPID_*` as used.
- `webhooks`: `ENCRYPTION_KEYS` (the api's), `STALWART_WEBHOOK_SECRET` (the mail
  server's), `STRIPE_WEBHOOK_SECRET` with billing.
- `ai`: `AI_SERVICE_SECRET` (the api's), the model provider's key and `AI_MODEL`,
  `AI_EMBEDDINGS`.

Plain settings shared by every environment (URLs between services, the site's origin,
ports) are in the stack chart's values; per-environment ones go in
`environments/<env>/stack.yaml`. The hosts in `environments/staging` and
`environments/production` (`site.host`, `storage.uploads.host`, `EMAIL_FROM`) are
placeholders: set yours.

## Secrets with SOPS

Each cluster has an age key pair. The private key is the Secret `sops-age` in the
`argocd` namespace (key `keys.txt`, which OpenTofu's bootstrap creates); Argo CD's repo
server decrypts with it in a sidecar that runs `sops`, the `sops` config management
plugin (`argocd/argo-cd-values.yaml`). Applications whose source says
`plugin: { name: sops }` get every `*.sops.yaml` file of their path, decrypted:
`environments/<env>/secrets/` with the stack, `platform/secrets/<env>/` with the
platform. The Secrets every preview shares (`environments/preview/secrets/`, test-mode
keys only) have an age key of their own: the cluster hosting previews holds it as
`preview.txt` next to its own `keys.txt`, and previews decrypt with it alone. A file
copied from staging's directory doesn't decrypt in a preview, and `charts:check` and the
pre-commit hook refuse any secret not encrypted to exactly the keys `.sops.yaml` names
for its directory.

`.sops.yaml` at the repository's root says who can decrypt what: per environment, the
cluster's public key and those of the people who edit its secrets. Its keys are
placeholders until you put yours in, and `sops` refuses to encrypt with them.

Setting up an environment, once (`age` and `sops` from your package manager):

```sh
age-keygen -o staging.agekey             # the cluster's key pair; prints its public key
age-keygen -o preview.agekey             # the previews' own, on the cluster hosting them
age-keygen -o ~/.config/sops/age/keys.txt   # yours, if you don't have one yet
```

Put both public keys in `.sops.yaml`'s staging rule, give `staging.agekey` to the
bootstrap (`infra/tofu/README.md`) and keep it somewhere safe outside the repository:
it's the only way to decrypt that environment's secrets. Then delete the local copy.

Creating or changing a Secret is a file edit:

```sh
# A new one: write the plain manifest, then encrypt it in place.
cat > deploy/environments/staging/secrets/api.sops.yaml <<'YAML'
apiVersion: v1
kind: Secret
metadata:
  name: boilerplate-api
stringData:
  BETTER_AUTH_SECRET: "…"
YAML
sops --encrypt --in-place deploy/environments/staging/secrets/api.sops.yaml

# Change one: opens it decrypted in $EDITOR and encrypts it again on save.
sops deploy/environments/staging/secrets/api.sops.yaml

# After changing .sops.yaml's keys (someone joins or leaves, a cluster's key rotates):
sops updatekeys deploy/environments/staging/secrets/*.sops.yaml
```

Only the values are encrypted (`data`, `stringData`), so a diff shows which Secret and
key changed without showing them. Application Secrets name no namespace (they go to
their Application's, which for previews is each preview's own); platform Secrets name
theirs. `charts:check` fails on any file there that isn't an encrypted Secret, or a
namespace where there shouldn't be one. The plain manifest must never be committed:
encrypt it before `git add`.

### Replacing a cluster's age key

The cluster's private key lives in three places, and all three change together: the
`sops-age` Secret in `argocd` (written by OpenTofu's bootstrap, which keeps it in
neither its state nor its plans), the `SOPS_AGE_KEY` secret of the `infra-<env>` GitHub
environment (what `infra.yml` applies with), and wherever you keep your safe copy. To
replace it, because it leaked or someone who had it left:

1. `age-keygen -o <env>.agekey`, and add its public key to the environment's rule in
   `.sops.yaml`, next to the old one.
2. `sops updatekeys` every file of the environment (`environments/<env>/secrets/` and
   `platform/secrets/<env>/`), and commit: every Secret now decrypts with either key.
3. Put the new private key in `SOPS_AGE_KEY` (`gh secret set SOPS_AGE_KEY --env
   infra-<env> < <env>.agekey`) and in your safe copy, raise `sops_keys_version` by one
   in the environment's tfvars, and apply (`infra.yml`, or `tofu apply` with
   `TF_VAR_sops_age_key`): OpenTofu can't see a write-only key change, so the version is
   what makes it write the new one.
4. Restart the repo server (`kubectl -n argocd rollout restart deploy/argocd-repo-server`)
   and check an Application still syncs.
5. Remove the old public key from `.sops.yaml`, `updatekeys` again and commit. If the old
   key leaked, every value it could decrypt leaked too: rotate those as well (the
   rotate-secrets skill). The previews' key (`preview.txt`, `SOPS_PREVIEW_AGE_KEY`) is
   replaced the same way, in `.sops.yaml`'s preview rule.

## Re-encrypting after a key rotation

The stack has a suspended CronJob, `<release>-reencrypt`, that never runs on its own.
After rotating `BETTER_AUTH_SECRETS` or `ENCRYPTION_KEYS` (the rotate-secrets skill),
start a Job from it:

```sh
kubectl -n boilerplate create job --from=cronjob/boilerplate-reencrypt reencrypt-$(date +%s)
kubectl -n boilerplate logs -f job/<that job>
```

It runs the api's image with the api's environment in a pod of its own. Don't
`kubectl exec` it into a running api pod: the second process shares that pod's memory
limit and gets the container OOM-killed. `bun run k8s:smoke` runs it on kind, so CI
runs it on every change to the charts.

## Object storage

Two RustFS servers per environment (data chart), each with its own root keys:

- **uploads**: the application's files. Browsers upload and download directly with
  presigned URLs at `storage.uploads.host`, a host of its own (not a path of the site,
  so uploaded files never run in the site's origin), routed through the gateway; the
  bucket's CORS rule lets the site's origins PUT and GET. The api signs for that public
  endpoint, the worker reads and writes in-cluster, and the web app allows it in its
  Content-Security-Policy (`storage: presign | internal | origin` in the stack values).
  Files are off where there's no ClamAV (kind, previews: `storage: none`).
- **backups**: Postgres's backups only. No route, a network policy that lets only
  Postgres in, and keys the application never gets.

A Job after every sync creates the buckets and sets the CORS rule, so both are
declared here rather than done by hand.

## Backups and restore

With `postgres.backups.enabled` (staging and production), the Barman Cloud plugin
archives every WAL segment as it's written and takes a base backup daily, to the
backups server's `backups` bucket, kept for `postgres.backups.retention`. Any moment
since the oldest base backup kept can be restored. Put the backups server on another
node than Postgres's primary (`storage.backups.nodeSelector`) so one lost disk can't
take both.

The backups server and the uploads server are in the cluster, so on its own a lost
cluster (or the one disk of a one-node cluster) would take the database, its backups
and every upload with it. `offsite` in the data values copies both buckets to
S3-compatible storage you run somewhere else, every hour: a CronJob per bucket runs
`rclone copy`, which never deletes there, so a wiped bucket in the cluster can't wipe
the copy (expire old objects with that bucket's lifecycle rules instead). Production
refuses to render without it (`offsite.required`). Its keys are the
`offsite-storage` Secret, in `environments/<env>/secrets/`. After losing the cluster,
copy the backups back into the new cluster's backups bucket before restoring (the
same `rclone copy`, the other way), and the uploads into its uploads bucket. That the
copy restores is checked every week: where there is one, the backup drill below restores
from it.

Restoring (a mistake in the data, or a new cluster): CloudNativePG only bootstraps a
cluster when it creates it, so restoring means a new cluster from the backups.

1. Find the folder the backups are in: the old cluster's `postgres.backups.serverName`,
   which defaults to its name (`boilerplate-postgres`).
2. In `environments/<env>/data.yaml` set:

   ```yaml
   postgres:
     backups:
       enabled: true
       serverName: boilerplate-postgres-2   # somewhere new: never over the old archive
     restore:
       enabled: true
       serverName: boilerplate-postgres     # step 1's
       targetTime: "2026-09-30T08:15:00Z"   # or leave empty for the latest
   ```

3. Commit it, and once Argo CD has synced, replace the running cluster:
   `kubectl -n boilerplate delete cluster boilerplate-postgres`. Its volumes go with it
   (the backups stay in RustFS); Argo CD creates it again from the new values, and
   CloudNativePG recovers the new instances from the last base backup before the
   target, then replays WAL up to it. The services fail their readiness checks until
   it's up, then reconnect. On a new cluster, the first sync does all of it.
4. The restored database has its roles and grants; CloudNativePG sets their passwords
   from this namespace's Secrets, so the services connect as before.
5. Set `restore.enabled` back to `false` (an existing cluster ignores its bootstrap
   either way) and keep the new `backups.serverName`: it's where backups go now.

The backups themselves are drilled every week where `postgres.drill.enabled` is on
(staging and production, Sundays at 04:30 UTC, after the 03:00 base backup): a CronJob
restores the latest base backup and the archived WAL into a scratch cluster,
`<release>-postgres-drill`, the way the procedure above would, and checks it against the
live database (the same tables, row-level security, policies, grants, functions and
extensions, from the same query `bun run db:restore-drill` uses) and that its last
transaction is under `maxAgeHours` old (WAL is reaching the backups). Then it deletes
the scratch cluster. Where there's an offsite copy (production), it restores from that
copy rather than the backups server in the cluster, so each week proves what a restore
after losing the cluster would start from: the copy is complete, recent and restorable.
While it runs, the scratch cluster takes as much disk as the live one (production's
`postgres.storage.size`, on a node Postgres can run on), and the comparison reads every
table of the live database once; if a node can't spare the disk, turn the drill off in
`environments/<env>/data.yaml` until it can. A failed drill is a failed Job:
`kubectl -n <env> logs job/<the latest <release>-restore-drill job>`; run one now with
`kubectl -n <env> create job --from=cronjob/<release>-restore-drill drill-now`.

`bun run db:restore-drill` (docs/database.md) is the second check, in CI: a `pg_dump` of
the test database restores to the same rows, grants and policies. kind has no backups
(no cert-manager for the plugin), so the CronJob's first real run is in staging. Doing
the whole procedure above by hand once after setting up is still worth it: the drill
proves the backups restore, not that you know the steps.

## What a lost node takes down

Some parts run once, on one node's disk (`local-path`), and some run twice but share a
disk on a one-node cluster. What each one needs to survive losing a node:

| Part | Now | When its node is lost | The way to more |
|---|---|---|---|
| Postgres | `postgres.instances` (2 in production), placed on different nodes where there are several | on one node, both instances go with the disk: restore from the backups (and the offsite copy) | three nodes or more, so the instances really are on different disks; CloudNativePG fails over by itself |
| Valkey | one pod, append-only file on its node | it stays Pending until the node is back, and queues, sessions and rate limits stop with it | `valkey.replication.enabled` in the environment's `data.yaml`: three nodes (`replication.replicas`, odd), each with a Sentinel that promotes a replica within seconds of the primary going, behind a proxy that the services' `REDIS_URL` already names, so nothing else changes. Needs three nodes or more to survive losing one; turning it on keeps the data (the first node is the old one) |
| RustFS (uploads, backups) | one server each | uploads stop, and are only in the offsite copy | RustFS in distributed mode (four or more drives across nodes), or any S3 outside the cluster |
| Stalwart | one pod on the mail node, which SPF and reverse DNS name | no mail leaves: sign-in codes, resets and invitations stop | a second mail node in SPF and the MX records, or a relay (`relay`, see Mail) |
| The services | two replicas or more, spread across nodes | nothing, on two nodes or more | more replicas and nodes |

Valkey's `maxmemory` stays at 60% of its memory limit or less (the chart refuses more):
rewriting the append-only file forks the server, and whatever is written meanwhile is
copied, so a rewrite under load with no headroom gets it OOM-killed. A replica's first
sync forks the primary the same way.

With replication on, a failover drops the connections to the old primary; the services
reconnect on their own, and a job a worker held at that moment is retried by BullMQ once
its lock expires. Writes the old primary accepted in its last second, before a replica
had them, can be lost (replication is asynchronous).

## Mail

Stalwart runs on every cluster (`platform/mail`, namespace `mail`), on the node
OpenTofu labels `boilerplate.dev/mail=true`: SPF and reverse DNS name that node's
address, so mail must leave from it. Its ports (25, 465, 587, 993) are a LoadBalancer
Service that k3s's ServiceLB answers only on that node, with a certificate for its
host name from cert-manager. Inside the pod the server listens on unprivileged ports
(2525, 4650, 5870, 9930; the chart's `mail.listeners`), which the Service maps the mail
ports to, so it runs like every other pod: as 10001, on a read-only root, with no
capability. The image's binary carries the capability to bind low ports, which the
kernel refuses to start without, so the pod runs a copy of it that doesn't. OpenTofu publishes the DNS records (the host, MX, SPF,
DKIM, DMARC), from the same DKIM key as `dkim.key` in the `stalwart` Secret.

Stalwart keeps its settings in its database and only takes them through its management
API. The chart applies them (`plan.ndjson`: logs to stdout, the listeners, exactly
these, the domain with our DKIM key
and certificate, the host name, the `no-reply` account the notifications service submits
as, the webhook) on every start, with the recovery administrator of a short-lived
recovery-mode server, before the real one starts; the administrator never works on the
server's open ports. Stalwart posts delivery failures to the webhooks service in the
cluster, signed with `STALWART_WEBHOOK_SECRET`; a changed setting restarts the pod.

Sign-in codes, password resets and invitations all go out this way, so a node that
can't deliver (outgoing port 25 blocked, or its address on a blocklist) breaks sign-in.
Where that's the case, set `relay` in `platform/mail/values.yaml`: Stalwart then sends
every message for another domain through that SMTP server, with its password as
`RELAY_PASSWORD` in the `stalwart` Secret. It still signs with our DKIM key, so DMARC
passes on DKIM even though SPF names only the mail node.

## Observability

Off unless a cluster opts in with the label `boilerplate.dev/observability: "true"` on
its Argo CD Secret. Then the observability ApplicationSet installs Jaeger
(`platform/jaeger`: traces, kept in memory) and kube-prometheus-stack (Prometheus,
Grafana, Alertmanager) in `observability`, and the envs and previews ApplicationSets
set `observability.enabled` in the stack, which points every service's OTLP export at
them: traces to Jaeger, metrics to Prometheus's OTLP receiver. Neither is public:

```sh
kubectl -n observability port-forward svc/jaeger 16686                        # traces
kubectl -n observability port-forward svc/kube-prometheus-stack-grafana 3000:80   # dashboards
```

The alerts add-on (`platform/alerts`) adds what Prometheus scrapes besides the services
(Postgres, cert-manager, the gateway's proxies, KEDA) and rules on it: WAL archiving
failing or stalled, no recent base backup, certificates close to expiring or not ready,
the gateway answering more than 5% errors, and a queue backing up. kube-prometheus-stack
brings its own for pods crash-looping or not ready, nodes and disks. Alertmanager
emails every warning and critical alert to OpenTofu's `alert_email` (the cluster's
`boilerplate.dev/alert-email` annotation), through the cluster's mail server as its
submission account, with that account's password in the `alertmanager-smtp` Secret.
Production refuses to render without an address, and OpenTofu without `alert_email`.
Mail bounces aren't alerted on yet: Stalwart's metrics aren't scraped.

None of that can report the cluster itself dying, or its mail server: the alerts would
have to leave through them. So the dead man's switch is outside every cluster, in
GitHub Actions: every half hour `.github/workflows/uptime.yml` runs
`scripts/uptime.ts`, which asks each environment's site (`/healthz`) and API
(`/api/v1/system`) at `site.host` for a 200, and the mail server, found through the
email domain's MX record (the domain of `EMAIL_FROM`), for its greeting on port 465.
It also watches the alerting itself, since Prometheus or Alertmanager can die while the
site stays up: kube-prometheus-stack's `Watchdog` alert always fires, and Prometheus
resends it to Alertmanager every minute or so. The api asks Alertmanager for it
(`ALERTMANAGER_URL`, which the stack chart sets with observability on) and answers
`/api/v1/system/alerting` with `ok` while one arrived in the last ten minutes, `stale`
when none did or Alertmanager doesn't answer, and `off` without observability; nothing
else of Alertmanager's answer leaves the cluster, and the verdict is cached for 30
seconds. The check fails on `stale`. Each check gets three tries. When one still fails, the run fails and opens the issue
"Uptime: an environment is down" listing what's down, which it keeps current and closes
once everything answers again; GitHub notifies the repository's watchers. Hosts left on
the `example.com` placeholders are skipped, so it does nothing until they're set. It
sees what users see, through Cloudflare, so it can't tell a dead cluster from a broken
gateway. GitHub turns off scheduled workflows in a
repository with no activity for 60 days; re-enable it from the Actions tab.

## DNS

OpenTofu's Cloudflare module owns the zone's records for the site, the previews
wildcard and mail, since it knows the nodes' addresses before anything runs. The one
host it doesn't know is the files host, so external-dns only publishes HTTPRoutes
annotated `boilerplate.dev/external-dns: "true"` (the data chart's uploads route),
proxied, and leaves every record it doesn't own alone. cert-manager validates the
gateway's and the mail server's certificates through Cloudflare DNS.

## GitOps

OpenTofu installs Argo CD on each cluster with `argocd/argo-cd-values.yaml` and applies
`argocd/root.yaml`; from then on everything comes from this repo. The ApplicationSets:

- **platform**: every add-on in `platform/addons` on every cluster with an environment:
  operators, the gateway and its certificates (`platform/config`), the mail server, the
  add-ons' Secrets. They roll out in the order of their `wave` (a step per wave, each
  once the one before is healthy), so what needs a CRD comes after what installs it.
- **observability**: `platform/addons/observability` on clusters that opt in.
- **envs**: the data and stack releases on the staging and production clusters, data
  first, and each environment's Secrets with the stack. A merge to master deploys
  staging (CI commits the new image tag); production changes only through a promotion
  pull request.

Each environment deploys from the git revision in `environments/<env>/release.yaml`
(the ApplicationSets read that file at master's head): the charts, values, Secrets and
platform add-ons. Staging's is `HEAD`, so it follows master. Production's is the tag of
the release it runs, with that release's images, and only `bun run promote` changes
it. So a merged change to a chart, values file or add-on reaches staging at once and
production with the next promotion. Changes to `argocd/` itself (the ApplicationSets,
projects, root) still reach every cluster on merge: review them as production changes.
- **previews**: a preview per pull request labelled `preview`, in its own namespace,
  at `https://pr-<number>.preview.<domain>`, deleted with the label or the PR, on the
  cluster that hosts previews (staging's). Each brings its own database and Valkey.

Clusters describe themselves in their Argo CD cluster Secret, which OpenTofu writes:

| On the cluster Secret | Meaning |
|---|---|
| label `boilerplate.dev/environment` | `staging` or `production`: gets the platform, and that environment's releases and Secrets |
| label `boilerplate.dev/previews: "true"` | hosts pull-request previews |
| label `boilerplate.dev/observability: "true"` | gets Jaeger and Prometheus, and the services export to them |
| annotation `boilerplate.dev/domain` | the DNS zone its hosts are in |
| annotation `boilerplate.dev/tls-email` | Let's Encrypt's account email |
| annotation `boilerplate.dev/image-policy` | `"true"`: only images CI signed run (production) |
| annotations `boilerplate.dev/mail-host`, `mail-domain` | the mail server's name and email domain, when not `mail.<domain>` and `<domain>` |

## Locally (kind)

`bun run k8s:up` runs the same charts on kind, on the Kubernetes the clusters run (the
node image in `local/kind.yaml` follows k3s's minor version): Envoy Gateway, CloudNativePG and KEDA
(which scales the worker on its queues) from their pinned add-on versions, a plain-HTTP gateway (`local/gateway.yaml`), Mailpit
instead of the mail server (`local/mailpit.yaml`), then data and stack. The data chart
generates its credentials as everywhere; the services' Secrets are generated by the
script straight into the cluster (never written to disk or git), and Mailpit gets a
certificate from an authority made for the cluster, since production settings only
submit mail over verified TLS. No Argo CD, cert-manager or backups. The smoke
test checks the routes (the site and the files host) and runs re-encryption.

docker compose (local development and CI's tests) runs the same images as the clusters
for Valkey, RustFS, ClamAV, the mail server, Jaeger and Mailpit
(`scripts/compose.test.ts` fails when one drifts). Postgres is the exception:
CloudNativePG runs its own PostgreSQL 18 image with pgvector, which doesn't start on its
own, so compose runs pgvector's image of the same major version. What kind leaves out
(Argo CD and its sops plugin, cert-manager, backups) is first exercised in
staging.
