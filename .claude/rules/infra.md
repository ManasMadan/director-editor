---
paths:
  - "deploy/**"
  - "infra/**"
  - "docker-bake.hcl"
  - "renovate.json5"
---

# deploy/ and infra/tofu

Never run `helm install/upgrade`, `kubectl apply`, `tofu apply` or anything that changes
a real cluster or cloud account. The checks below are offline.

- Helm charts are `deploy/charts/stack` and `deploy/charts/data`. Both
  `values.schema.json` files set `additionalProperties: false`: a new value needs its
  schema entry, or `helm template` fails.
- Every template change gets a helm-unittest case in `deploy/charts/<chart>/tests/`.
- Environments are `deploy/environments/<env>/{data,stack}.yaml`. A new environment
  must also be added to `RELEASE_VALUES` in `scripts/charts.ts`.
- `bun run charts:check`: lint, unit tests, every environment rendered and validated
  with kubeconform, platform add-ons at their pinned versions, Argo CD manifests. Needs
  helm with the helm-unittest plugin.
- Image tags in `deploy/environments/` are written by CI: staging's in its `stack.yaml`
  on every merge to master, production's with its revision in `release.yaml` through a
  promotion PR. Do not edit them by hand.
- OpenTofu: modules in `infra/tofu/modules/<name>` (k3s, cloudflare or rfc2136 for DNS, bootstrap), one root
  in `infra/tofu/envs/k3s` used per environment through tfvars. Every module has
  `tests/*.tftest.hcl` with `mock_provider`, so tests need no credentials.
  `bun run infra:check` runs fmt, validate and every test; `bun run lint:tflint` (part of
  `bun run lint`) runs tflint with every rule of its Terraform ruleset, so an output or
  variable needs a description and a provider is declared where it's used.
- Dockerfiles pass hadolint and shell scripts shellcheck (`bun run lint:hadolint`,
  `lint:shellcheck`). A chart script runs under `sh`, which its folder's `.shellcheckrc`
  tells shellcheck.
- Everything runs in the cluster: no managed databases, caches, storage, secret
  managers or mail services. Third-party APIs (AI providers, Twilio, push, Stripe,
  Google, Turnstile) and Cloudflare in front (optional: `dns.provider = "rfc2136"` runs
  without it) are the exceptions; ask before adding a
  managed dependency.
- Pin every version: images by tag (the Dockerfiles' base images by tag and digest,
  `scripts/dockerfiles.test.ts`), charts and providers by exact version. Anything
  Renovate cannot find on its own gets a comment on the line above:
  `# renovate: datasource=<docker|helm|github-releases|npm> depName=<name>` (see
  `infra/tofu/modules/bootstrap/variables.tf` and `.github/workflows/ci.yml`). A new
  file pattern needs a custom manager in `renovate.json5`.
- `bun scripts/misconfig.ts` (as the Security workflow and the pre-commit hook run it)
  renders every chart of ours into `deploy/.rendered` (git ignores it): the stack and
  data charts for every environment and optional feature, the platform's own charts (the
  add-ons with a `path`) with a cluster's values, and the third-party ones (the other
  add-ons and Argo CD) at their pinned versions with `deploy/platform/values` (pulled
  once into `~/.cache/boilerplate/charts`, without their Helm tests). A third-party
  chart's containers get their resources and users through its values; what an operator
  or node-exporter needs by design is a reviewed exception scoped to its
  `deploy/.rendered/addon-<name>.yaml`. Trivy's own Helm rendering is off
  (`trivy.yaml`): it skipped every chart that needs a value. LimitRanges and
  ResourceQuotas are scanned in passes of their own (`deploy/.rendered/isolated`), since
  with one in the scan Trivy checks every manifest as if it were one. It runs Trivy's
  `config` scan and fails on any finding in those, the Dockerfiles, the other manifests
  and OpenTofu (evaluated with `production.tfvars.example`): containers run as UID and
  GID 10001 on a read-only root, with no added capability (a server listens on an
  unprivileged port; the Service maps the public one to it) and CPU and memory limits,
  every object names `{{ .Release.Namespace }}`, images come from a registry in
  `deploy/trivy/registries.yaml`, and a long-running image has a HEALTHCHECK. A finding
  that doesn't apply goes under `misconfigurations` in `.trivyignore.yaml`, with its
  reason, for the files it applies to. A new chart anywhere under `deploy/` must be
  rendered there too (`scripts/misconfig.test.ts` fails otherwise).
- Secrets never go in values files or tfvars. They're SOPS-encrypted Secrets in
  `deploy/environments/<env>/secrets/` and `deploy/platform/secrets/<env>/`, or generated
  in the cluster by the data chart; never decrypt one (rotate-secrets skill).
