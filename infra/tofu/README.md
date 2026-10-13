# Infrastructure (OpenTofu)

Everything runs on k3s on machines you rent or own, anywhere: one root, `envs/k3s`,
used once per environment (staging, production) with its own variables and state. It
installs k3s on the machines, publishes its DNS (Cloudflare in front by default, or a
name server of your own), and hands the cluster to Argo CD, which deploys the rest from this repository (see `deploy/README.md`): Postgres
(CloudNativePG), Valkey, object storage (RustFS), the mail server (Stalwart) and the
services all run in the cluster.

```
modules/
  k3s          a list of machines → a k3s cluster, over SSH (or as cloud-init user data)
  cloudflare   zone TLS settings, optional WAF, the site's and the mail server's DNS
               records, an API token for the zone's DNS (cert-manager) and the
               Turnstile widget
  rfc2136      the same records on a name server of your own, through TSIG-signed
               dynamic updates (dns.provider = "rfc2136"): no Cloudflare at all
  bootstrap    Argo CD with the SOPS age key, the cluster's registration (labels and
               annotations the ApplicationSets read) and the root Application
envs/k3s
```

`bun run infra:check` runs `tofu fmt`, `validate` and every module's and root's tests.
The tests run against mocked providers, so they create nothing, connect to nothing
and need no credentials.

## The machines

Any Linux machines with systemd and curl (Ubuntu, Debian, Rocky, …, x86_64 or arm64),
a public IPv4 address each, and SSH with a key for root or a user with passwordless
sudo. Create them wherever you like (Hetzner, OVH, DigitalOcean, your own hardware);
OpenTofu doesn't create them, it takes their addresses. If the provider offers a
private network between them, use it (`private_address`).

- **One machine** is a whole environment: the server runs the control plane and every
  workload. Good for staging and small production.
- **Three servers** keep the cluster up when one fails (embedded etcd needs a
  majority, so two is no better than one). Add **agents** for more capacity.

How much memory: the application and its data ask for about 7 GB on staging and about
14 GB on production (`resources.requests` in `deploy/environments/<env>/`, summed over
their replicas), the platform (Argo CD, cert-manager, Envoy Gateway, KEDA, Kyverno,
CloudNativePG, the mail server) for about 2.5 GB more, observability for about 2 GB,
and k3s itself for about 1 GB. So staging fits one machine of 16 GB (each preview it
hosts can take up to 8 GB more, its quota), and production needs about 20 GB in all:
three machines of 8 GB, or one of 32 GB. Four vCPUs per machine is a sensible floor.
Pods that don't fit stay Pending; `kubectl describe pod` says which resource ran out.

Open these ports in the provider's firewall:

| Port | From | For |
|---|---|---|
| 80, 443 | anywhere (Cloudflare, and previews directly) | the gateway (the site's hosts only answer Cloudflare, see below) |
| 25, 465, 587, 993 | anywhere, on the mail node | the mail server |
| 22, 6443 | where OpenTofu runs (your machine, the CI runner) | installing k3s, the Kubernetes API |
| 6443, 10250, 8472/udp (vxlan) or 51820/udp (wireguard-native) | the other nodes | k3s |
| 2379–2380 | the other servers | etcd |

Every node answers on the gateway's and the mail server's ports: k3s's ServiceLB
listens on each node for LoadBalancer Services. Many providers block outgoing port 25
on new accounts; ask them to lift it for the mail node.

## Setting up an environment

Once, outside this root: an S3-compatible bucket for state that isn't in the cluster it
describes (R2, B2, Hetzner Object Storage, …), a passphrase to encrypt state with, and
the environment's age key for SOPS (`age-keygen -o <env>.agekey`: the environment's
secrets are encrypted to its public key, see `deploy/README.md`). Then:

```sh
cd infra/tofu/envs/k3s
cp backend-staging.hcl.example backend-staging.hcl   # backend-production.hcl.example for production
cp staging.tfvars.example staging.tfvars          # your machines, domain, …
export CLOUDFLARE_API_TOKEN=…                     # see modules/cloudflare for its permissions
export TF_VAR_ssh_private_key="$(cat ~/.ssh/boilerplate)"
export TF_VAR_sops_age_key="$(cat staging.agekey)"
export TF_VAR_sops_preview_age_key="$(cat preview.agekey)"   # with previews = true
export TF_VAR_state_passphrase=…
tofu init -backend-config=backend-staging.hcl
tofu apply -var-file=staging.tfvars
tofu output -raw kubeconfig > ~/.kube/boilerplate-staging
```

State holds the cluster's certificate authorities, join tokens and admin key; it's
encrypted with the passphrase before it leaves your machine, and without the passphrase
the environment can't be managed any more, so keep it safe.

The SSH key and the age keys are only needed to apply: they're ephemeral, so they're in
neither the state nor a saved plan, and the age keys go to the cluster as write-only
data. A plan runs without them (pull request plans do, see
`.github/workflows/infra.yml`). Because OpenTofu can't see a write-only value change,
replacing an age key means raising `sops_keys_version` too (the rotate-secrets skill).

Then put what OpenTofu made into the environment's SOPS secrets (see
`deploy/README.md`): `tofu output -raw cloudflare_dns_api_token` for cert-manager and
`tofu output -json turnstile` for the api. Point `site.host` in
`deploy/environments/<env>/stack.yaml` at `site_host`, and Argo CD takes it from there.
Set `previews = true` on the environment whose cluster also runs pull-request previews
(normally staging), and `observability = true` where Jaeger, Prometheus and Grafana
should run, with `alert_email` for where their alerts go (required in production).

### Machines made with cloud-init

If you create the machines with user data instead of letting OpenTofu in over SSH, set
`install_over_ssh = false`, render it, create the machines with it, and then apply the
rest:

```sh
tofu apply -var-file=staging.tfvars -target=module.k3s
tofu output -json cloud_init                      # { "<node>": "#cloud-config …" }
# create each machine with its user data, at the address in tfvars; once k3s is up:
tofu apply -var-file=staging.tfvars
```

The user data holds the node's secrets (join token, and the CAs on the first server), so
treat it like them. It's the same configuration and installer as over SSH.

## Changing the cluster

- **Adding a node**: add it to `nodes` and apply. Nothing changes on the other nodes,
  except when a single server gets its first companions: the first server then turns
  on embedded etcd (k3s moves its SQLite datastore over on the restart). Go from one
  server to three, not two.
- **Replacing a machine** (rebuilt, or moved to another one): keep its name, change its
  address if it has a new one, and apply; if the address stays the same, say so with
  `tofu apply -replace='module.k3s.terraform_data.agent["<name>"]'` (`.server[…]` for a
  server). It rejoins as the same node, with the same node password; whatever was on
  its local volumes is gone, so CloudNativePG rebuilds its replica there.
- **Removing a node**: `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data`,
  `kubectl delete node <node>`, remove it from `nodes`, apply, and delete the machine.
- **The first server** (the first by name) created the cluster. With one server,
  replacing it is a new, empty cluster. With three, if it's lost for good:
  `kubectl delete node <name>` (k3s takes it out of etcd), remove it from `nodes` and
  apply; the next server by name becomes the first. Add the replacement under a new
  name that sorts after the others (server-4).
- **Upgrading k3s**: Renovate raises `k3s_version` in `modules/k3s`; applying upgrades
  the first server, then the other servers, then the agents, in place (pods keep
  running while k3s restarts). `tofu apply -parallelism=1` takes one node at a time.
- **Labels and taints** are set when a node registers; to change them on a running
  node, also run `kubectl label` / `kubectl taint`.

OpenTofu's admin certificate lasts a year and renews on any apply in its last 60 days.
If it has expired, renew it first: `tofu apply -target=module.k3s.tls_locally_signed_cert.admin`.

## DNS

`dns.provider` chooses where the records live: `cloudflare` (the default) or `rfc2136`
(a name server of your own that accepts dynamic updates signed with a TSIG key: BIND,
Knot, PowerDNS; `dns.rfc2136` names it and the key, `TF_VAR_dns_tsig_secret` is the
key's secret). Either way the same records are published, and OpenTofu tells the cluster
(its `dns-*`, `trusted-hops` and `origin-pulls` annotations), so cert-manager validates
certificates on the same DNS, external-dns writes there, and the gateway trusts
Cloudflare's hop and certificate only when Cloudflare is in front. Moving an environment
is the `swap-dns` skill. With RFC 2136 nothing is proxied: the site's records point at
the nodes, there's no WAF or CDN in front, and the captcha (Turnstile) isn't created.

The cloudflare module sets up, in the environment's zone:

| Record | Proxied | What |
|---|---|---|
| `site_host` A (AAAA) → every node, or `origin_ips` | yes | the site, behind Cloudflare's WAF and CDN |
| `*.preview.<domain>` A → the same | no | pull-request previews (staging): the free edge certificate covers only one level of subdomain, so the gateway serves these with its own |
| `mail.<domain>` A (AAAA) → the mail node | no | the mail server (SMTP and IMAP can't go through the proxy) |
| `<domain>` MX → `mail.<domain>` | – | incoming mail |
| `<domain>` TXT `v=spf1 ip4:… -all` | – | only the mail node sends for the domain |
| `<selector>._domainkey.<domain>` TXT | – | DKIM: the public key from `mail.dkim_public_key` |
| `_dmarc.<domain>` TXT | – | DMARC, with reports to `mail.dmarc_report_email` |

`tofu output dns_records` lists them. The mail node is the one named in `mail.node`; it
gets the label `boilerplate.dev/mail=true`, which the mail server is scheduled by, so
its mail leaves from the address SPF names.

Two things for mail aren't in Cloudflare:

- **Reverse DNS**: set the mail node's PTR record to `mail.<domain>` at the provider
  the address belongs to (usually in the server's network settings). Receivers reject
  or spam-folder mail from an address whose reverse DNS doesn't match.
- **The DKIM key pair** is generated once, outside OpenTofu; the private key goes into
  the mail server's SOPS secret, the public key into tfvars:

  ```sh
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out dkim.pem
  openssl pkey -in dkim.pem -pubout -outform DER | base64 | tr -d '\n'   # dkim_public_key
  ```

Cloudflare presents its origin-pull client certificate on every request (the module
turns on authenticated origin pulls), and the gateway refuses the TLS handshake for the
site's hosts without it. So someone who finds a node's address can't skip Cloudflare,
and the client address the services rate-limit on (from `X-Forwarded-For`) is the one
Cloudflare saw. Previews are reached directly, so the gateway drops any
`X-Forwarded-For` their visitors send. Apply the module before the platform chart
first requires the certificate, or the site is refused in between. Restricting 80 and
443 to Cloudflare's ranges at the provider's firewall is a further option, but only on
a cluster without previews.

Anything that bypasses Cloudflare (previews, the mail host) shows the nodes' real
addresses; the proxy hides the site's origin only if the site runs on nodes that serve
nothing else publicly.
