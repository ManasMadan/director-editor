# Starting a new project from this boilerplate

Everything a new app needs once, in order. Each step links to where the details live;
tick them off in your own copy of this file or in an issue.

## 0. Tools

Beyond what local development needs (Node, Bun, Docker, uv; `bun run doctor` checks
those), shipping needs these on your machine. The doctor doesn't check them; the
devcontainer (`.devcontainer/`) has all of them but Worktrunk, pinned and checked
against their checksums.

| Tool | For |
|---|---|
| `gh` | the repository settings and releases ([repository-settings.md](repository-settings.md)) |
| `sops` and `age` | creating and editing the encrypted Secrets (step 4) |
| `tofu` (OpenTofu) | the machines, DNS and the cluster's bootstrap (step 5); `bun run infra:check` |
| `helm` with the `helm-unittest` plugin | `bun run charts:check` |
| `kubectl` | checking the first deploy (step 7) |
| `kind` | `bun run k8s:up`, the whole stack in a local cluster before a real one |
| `wt` (Worktrunk, optional) | one worktree per branch, for parallel work and Claude Code agents (`.config/wt.toml`) |

## 1. Make it yours

- [ ] Create the repository from this one (it's a template repository once its settings
      are applied, see step 3): `gh repo create <owner>/<name> --template
      ManasMadan/boilerplate --public --clone`.
- [ ] Rename the owner, repository, product and mobile app: `bun run rename <name>
      --owner <owner> --product "<Product>" --bundle-id <com.example.app>`. It rewrites
      every tracked file (the repository in Argo CD's `repoURL`s and the bootstrap, the
      image registry `ghcr.io/<owner>/<name>`, `CODEOWNERS` and the security links, the
      product name in auth, the API docs and the UI's messages, the mobile bundle id and
      URL scheme, and the `boilerplate` name in compose, kind, Kubernetes labels and
      resources, cookies and test addresses), then fails naming any line it couldn't.
      The bundle id can't change once the app is in a store. Then `bun install` and
      review the diff. In Claude Code, `/new-project` walks this list with you.
- [ ] Your domains in `deploy/environments/{staging,production}/`: `site.host`,
      `storage.uploads.host` and `corsOrigins` (data.yaml), `EMAIL_FROM`. The
      `example.com` values there are placeholders.
- [ ] Drop what you don't need: each optional feature is off until its variables are
      set, so an unused one costs nothing but code. To remove one completely (code,
      tables in a later release, env, copy, docs, tests), follow the remove-feature
      runbook (`.claude/skills/remove-feature/SKILL.md`, or `/remove-feature <feature>`
      in Claude Code).

## 2. Develop locally

- [ ] `bun run setup`: writes `.env` from `.env.example` with fresh local secrets, starts
      the local services and migrates. `bun run doctor` checks the toolchain and warns
      about variables in `.env` that `.env.example` no longer has (after pulling a
      change that removed some): delete those lines by hand. A `.env` from an older
      checkout of this repository may still have `EMAIL_PROVIDER`, `RESEND_API_KEY`,
      `RESEND_WEBHOOK_SECRET` and `STRIPE_MOCK_PORT`: nothing reads them any more.
- [ ] `bun run dev`, then the tests (`CLAUDE.md` has the commands).

## 3. The GitHub repository

[repository-settings.md](repository-settings.md) has each setting, and the commands.

- [ ] Merge settings, the `master` ruleset, security features, environments.
- [ ] The GitHub App (the web UI only): the staging deploy pushes to `master` with it,
      and Renovate runs as it.
- [ ] After the first images are pushed: link each GHCR package to the repository and
      choose its visibility.
- [ ] The `preview` label, which maintainers put on a pull request to give it an
      environment: `gh label create preview --description "Deploy a preview environment"`.
      The address (`https://pr-<number>.preview.<domain>`, the domain of the cluster that
      hosts previews) is posted on the pull request by Argo CD once the preview runs: give
      the GitHub App Pull requests: write, and put its app id, installation id and private
      key in that cluster's `argocd-notifications-secret` (deploy/README.md).
- [ ] `TOFU_TARGETS`, a repository variable listing the environments that get a plan
      on infrastructure pull requests, e.g. `["staging", "production"]`. Unset, no plans.
- [ ] Optional: take the Claude Code setup from this template instead of keeping a copy,
      so its fixes reach this app. The template is a plugin marketplace
      (`.claude-plugin/`): `/plugin marketplace add ManasMadan/boilerplate`, then
      `/plugin install boilerplate@boilerplate`, and commit the two to
      `.claude/settings.json` (`extraKnownMarketplaces`, `enabledPlugins`) for everyone.
      Then delete this app's `.claude/skills`, `.claude/agents`, `.claude/output-styles`,
      `.claude/bin` and the `hooks` block of `.claude/settings.json`, or everything runs
      twice. Keep `playwright-core` in the root `package.json`: the plugin's
      `playwright-cli` command runs the app's copy. The
      plugin has no version, so each commit to the template's default branch is an
      update. Its skills and agents are then named `boilerplate:<name>`. Installing it
      also installs the plugins from Anthropic's marketplace that the template enables
      (its `dependencies`; `.claude/rules/claude-setup.md` says what each needs).
- [ ] Optional: a Claude Code review on every pull request (`claude-review.yml`, the
      repository's own reviewer agents, one comment, never a required check). Set the
      `CLAUDE_REVIEW` repository variable to `true` and the `ANTHROPIC_API_KEY` secret.
- [ ] Under an organization rather than a personal account, the gitleaks action in
      `security.yml` needs a license: get a free one at gitleaks.io, store it as the
      `GITLEAKS_LICENSE` repository secret, and pass it to the step
      (`env: GITLEAKS_LICENSE: ${{ secrets.GITLEAKS_LICENSE }}`). Without it the
      **Secrets in the history** check fails, and the ruleset requires it.
- [ ] A private repository also needs:
      - GitHub Code Security (Advanced Security) for code scanning, which the Security
        workflow uploads to and the ruleset gates on; it's free only on public ones.
      - Argo CD credentials to read it: a platform Secret per environment,
        `deploy/platform/secrets/<env>/repository.sops.yaml` (template in step 4).
      - Credentials to pull the images, if the GHCR packages stay private: a pull Secret
        in each environment's `secrets/` (template in step 4), named in
        `image.pullSecrets` in `deploy/environments/<env>/stack.yaml` (the preview one in
        `deploy/environments/preview/stack.yaml`).

## 4. Secrets for each environment

[deploy/README.md](../deploy/README.md), "Secrets with SOPS" and "Credentials".

- [ ] An age key pair per environment (`age-keygen -o <env>.agekey`), one for the
      previews (`preview.agekey`) and one for you; the public keys in `.sops.yaml` (its
      keys are placeholders, and `sops` refuses them). Keep each environment's private key outside the repository: it's the only
      way to decrypt that environment's secrets.
- [ ] The DKIM key pair for mail ([infra/tofu/README.md](../infra/tofu/README.md), DNS).
- [ ] The encrypted Secrets: one per service in `deploy/environments/<env>/secrets/`,
      and the platform's (Cloudflare token, mail server, GitHub token for previews,
      Grafana) in `deploy/platform/secrets/<env>/`. The table in deploy/README.md lists
      every key. `bun run charts:check` refuses any file there that isn't encrypted.

The directories start empty. For each file below: write it in plain text at the path
shown, fill in the values, run `sops --encrypt --in-place <file>`, and only then
`git add` it (the pre-commit hook refuses a plain one). Database, Valkey and storage
credentials aren't here: the data chart generates them in the cluster. Plain settings
(URLs, `EMAIL_FROM`, `site.host`) go in `stack.yaml`, not here. The keys come from each
service's `src/env.ts` (`apps/ai/app/settings.py` for ai); commented ones are optional,
and a feature stays off until its keys are set.

`deploy/environments/<env>/secrets/api.sops.yaml`:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: boilerplate-api
stringData:
  BETTER_AUTH_SECRET: ""   # openssl rand -base64 48
  ENCRYPTION_KEYS: ""      # echo "$(date +%Y-%m):$(openssl rand -base64 32)"; the same in webhooks
  UNSUBSCRIBE_SECRET: ""   # openssl rand -base64 32; the same in notifications
  AI_SERVICE_SECRET: ""    # openssl rand -base64 32; the same in ai
  # GOOGLE_CLIENT_ID: ""           # Google sign-in (step 6)
  # GOOGLE_CLIENT_SECRET: ""
  # TURNSTILE_SITE_KEY: ""         # tofu output -json turnstile
  # TURNSTILE_SECRET_KEY: ""
  # STRIPE_SECRET_KEY: ""          # billing: sk_live_… (sk_test_… on staging)
  # STRIPE_PRICE_PRO_MONTHLY: ""   # price_…
  # STRIPE_PRICE_PRO_YEARLY: ""
  # VAPID_PUBLIC_KEY: ""           # browser push: the public half of notifications' pair
```

`deploy/environments/<env>/secrets/notifications.sops.yaml`:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: boilerplate-notifications
stringData:
  UNSUBSCRIBE_SECRET: ""   # the api's value
  SMTP_URL: ""             # smtps://no-reply%40<email domain>:<SMTP_PASSWORD>@<mail host>:465 (not for previews: their mail stays in their own Mailpit)
  # SMS_PROVIDER: twilio           # with the three below
  # TWILIO_ACCOUNT_SID: ""         # AC…
  # TWILIO_AUTH_TOKEN: ""
  # TWILIO_FROM: ""                # +E.164 number, or a Messaging Service SID (MG…)
  # FCM_PROJECT_ID: ""             # Android push: from the Firebase service account JSON
  # FCM_CLIENT_EMAIL: ""
  # FCM_PRIVATE_KEY: ""
  # APNS_KEY_ID: ""                # iOS push: the .p8 key's id (step 6)
  # APNS_TEAM_ID: ""
  # APNS_PRIVATE_KEY: ""           # the .p8 file's contents
  # APNS_BUNDLE_ID: ""             # com.boilerplate.app, or yours after the rename
  # VAPID_PUBLIC_KEY: ""           # browser push: bunx web-push generate-vapid-keys
  # VAPID_PRIVATE_KEY: ""
  # VAPID_SUBJECT: ""              # mailto:you@<domain>
```

`deploy/environments/<env>/secrets/webhooks.sops.yaml`:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: boilerplate-webhooks
stringData:
  ENCRYPTION_KEYS: ""            # the api's value
  STALWART_WEBHOOK_SECRET: ""    # the mail server's (its platform Secret below)
  # STRIPE_WEBHOOK_SECRET: ""    # whsec_…, from the webhook endpoint (step 6)
```

`deploy/environments/<env>/secrets/ai.sops.yaml` (the AI worker uses it too):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: boilerplate-ai
stringData:
  AI_SERVICE_SECRET: ""    # the api's value
  AI_MODEL: ""             # e.g. anthropic:claude-sonnet-5; production refuses local:*
  AI_EMBEDDINGS: ""        # a real embedding model; production refuses hashing
  ANTHROPIC_API_KEY: ""    # or OPENAI_API_KEY, for the provider AI_MODEL names
  # AI_FALLBACK_MODEL: ""
```

`deploy/platform/secrets/<env>/stalwart.sops.yaml` (the mail server; the full list of
keys and the DKIM key's format are in `deploy/platform/mail/values.yaml`):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: stalwart
  namespace: mail
stringData:
  ADMIN_PASSWORD: ""             # openssl rand -hex 24
  SMTP_PASSWORD: ""              # openssl rand -hex 24 (only letters, digits, ._~-); also in SMTP_URL
  STALWART_WEBHOOK_SECRET: ""    # openssl rand -base64 32; also in webhooks
  dkim.key: ""                   # the DKIM private key (infra/tofu/README.md, DNS)
```

A private repository, `deploy/platform/secrets/<env>/repository.sops.yaml`, with a
fine-grained token that can read the repository's contents:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: repository
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository
stringData:
  type: git
  url: https://github.com/<owner>/<repo>
  username: git
  password: ""   # the token
```

Private images, `deploy/environments/<env>/secrets/ghcr-pull.sops.yaml` (and in
`deploy/environments/preview/secrets/` for previews), with a token that can read
packages; then `image.pullSecrets: [{ name: ghcr-pull }]` in that environment's
`stack.yaml`:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: ghcr-pull
type: kubernetes.io/dockerconfigjson
stringData:
  .dockerconfigjson: '{"auths":{"ghcr.io":{"auth":"<base64 of user:token>"}}}'
```

Production's copy of its backups and uploads outside the cluster: S3-compatible storage
you run on another machine, somewhere else (a RustFS or MinIO), with a bucket for it.
Put its address, bucket and a folder in `offsite` in
`deploy/environments/production/data.yaml` (the render fails in production until
they're set: deploy/README.md, "Backups and restore"), and its keys in
`deploy/environments/production/secrets/offsite-storage.sops.yaml`:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: offsite-storage
stringData:
  accessKeyId: ""
  secretAccessKey: ""
```

The other platform Secrets (the Cloudflare token for cert-manager and external-dns, the
GitHub token for previews, Grafana's admin, the password Alertmanager emails alerts
with) are in the table in deploy/README.md. Production needs somewhere to send alerts:
`alert_email` in its tfvars, with `observability = true` (deploy/README.md,
"Observability").

## 5. Machines, DNS and the cluster

[infra/tofu/README.md](../infra/tofu/README.md).

- [ ] Machines anywhere (one for staging is enough; production can grow to three
      servers and agents), a state bucket, a Cloudflare zone and API token.
- [ ] The provider's firewall, per machine:

      | Port | From | For |
      |---|---|---|
      | 80, 443 | Cloudflare's addresses (https://www.cloudflare.com/ips/) on production; anywhere on the cluster that hosts previews, whose hosts aren't proxied | the gateway |
      | 25, 465, 587, 993 | anywhere, on the mail node | the mail server |
      | 22, 6443 | only where OpenTofu runs: your address, or a self-hosted runner's (GitHub's hosted runners have no fixed addresses) | installing k3s, the Kubernetes API |
      | 6443, 10250, 8472/udp (or 51820/udp with WireGuard) | the other nodes only | k3s |
      | 2379, 2380 | the other servers only | etcd |

      Opening 80 and 443 to anywhere lets a client reach the nodes without Cloudflare and
      set its own `X-Forwarded-For`, which the per-IP rate limits trust. Keep the
      previews on a cluster that holds nothing production needs.
- [ ] Outgoing port 25 on the mail node: many providers block it on new accounts, and
      mail then never leaves. Ask the provider to lift it (a support ticket, often with
      a question about what you'll send). Check with
      `nc -vz gmail-smtp-in.l.google.com 25` from the node.
- [ ] The mail node's address on the blocklists, before you rely on it: look it up at
      https://mxtoolbox.com/blacklists.aspx (Spamhaus, Barracuda, …). A listed address
      from a cheap range sends codes and invitations to spam or nowhere; ask the provider
      for another one, or request delisting. If neither port 25 nor the address can be
      fixed, send through a relay instead (`relay` in `deploy/platform/mail/values.yaml`,
      deploy/README.md "Mail").
- [ ] `<env>.tfvars` from the example; `tofu apply`; put its outputs (the DNS token,
      Turnstile keys) into the SOPS secrets.
- [ ] Reverse DNS of the mail node set to `mail.<domain>` at the machines' provider, for
      its IPv6 address too if it has one (receivers check the address mail came from).
- [ ] The infra workflow's secrets per `infra-<env>` environment, to plan and apply from
      CI, and the read-only ones per `infra-<env>-plan`, for pull request plans
      (repository-settings.md).

## 6. Third-party accounts

Each is optional; turn on the ones you use, per environment.

- [ ] **Google sign-in.** In Google Cloud's console, an OAuth client of type Web
      application with the authorized redirect URI
      `https://<site host>/api/auth/callback/google` (and
      `http://localhost:3000/api/auth/callback/google` for local development), and the
      site's origin as an authorized JavaScript origin. Its id and secret go in the api's
      Secret (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).
- [ ] **Stripe.** Two recurring prices for the Pro plan (monthly and yearly), then a
      webhook endpoint at `https://<site host>/webhooks/stripe` (Developers, Webhooks)
      listening to exactly these events, the ones
      `apps/api/src/modules/billing/billing-events.processor.ts` acts on:
      `checkout.session.completed`, `customer.subscription.created`,
      `customer.subscription.updated`, `customer.subscription.deleted`,
      `customer.subscription.paused`, `customer.subscription.resumed`, `invoice.paid` and
      `invoice.payment_failed` (it re-syncs the subscription on any `invoice.*` event and
      tells the owners about a failed payment). Its signing secret (`whsec_…`) goes in the
      webhooks Secret, the key and prices in the api's. Staging uses test mode.
- [ ] **The mobile app on EAS.** An expo.dev account, then:
      - `(cd apps/mobile && bunx eas-cli init)` creates the project and prints its id: the
        `EAS_PROJECT_ID` repository variable. A robot token from expo.dev is the
        `EXPO_TOKEN` secret. Until the variable is set, `mobile.yml` does nothing.
      - `EXPO_PUBLIC_API_URL` per EAS environment (`development`, `preview`,
        `production`), the site's origin for each:
        `(cd apps/mobile && bunx eas-cli env:create --environment production --name EXPO_PUBLIC_API_URL --value https://<site host> --visibility plaintext)`.
      - Store credentials: an Apple Developer account and a Google Play developer
        account, the apps created in App Store Connect and the Play Console, then
        `(cd apps/mobile && bunx eas-cli credentials)` for the signing certificates, and
        an App Store Connect API key and a Play service account for `eas submit`.
      - Push: an APNs key (`.p8`, Apple Developer, Keys, with Apple Push Notifications)
        gives `APNS_KEY_ID`, `APNS_TEAM_ID` and `APNS_PRIVATE_KEY`; a Firebase project
        with the Android app, and a service account's JSON key, gives `FCM_PROJECT_ID`,
        `FCM_CLIENT_EMAIL` and `FCM_PRIVATE_KEY`. Both go in notifications' Secret.
      - Optional, links that open the app and its passkeys: the team id, bundle id,
        package and signing fingerprints in each environment's web `env`, the
        fingerprints in its api's, and the team id and fingerprints in the EAS environment
        ([web-and-mobile.md](web-and-mobile.md), "Universal links and App Links"). Off
        until set; set all four or none, since a partial set stops the web app.
      - The bundle id, package and scheme in `apps/mobile/app.config.ts` can't change
        after the first store release: rename them before it.

## 7. The first deploy: check what only a real cluster shows

CI tests everything it can against local stand-ins (kind, fake providers, a local
Stalwart and RustFS); these need the real environment, once:

- [ ] Argo CD shows every application synced and healthy (`kubectl -n argocd get
      applications`), which also proves it decrypted the SOPS secrets.
- [ ] The site loads through Cloudflare, and `tofu output dns_records` matches the zone.
- [ ] Going around Cloudflare fails: `curl -v --resolve <site>:443:<node-ip>
      https://<site>/` ends in a TLS alert (the gateway wants Cloudflare's origin-pull
      certificate), so nobody can forge the client address rate limits use.
- [ ] Mail: sign up with a real address; the email arrives, not in spam, with DKIM,
      SPF and DMARC passing (the message's `Authentication-Results` header). Send to a
      non-existent address at a real domain: the bounce reaches the webhooks service and
      the address is suppressed (notifications' logs).
- [ ] Backups: `kubectl -n boilerplate get backups` shows a completed one, and a restore
      into a new cluster works (deploy/README.md, "Backups and restore": try it on
      staging before production needs it).
- [ ] Uploads: a profile picture uploads and shows (RustFS through the files host).
- [ ] With observability on: traces in Jaeger and metrics in Grafana for every service.
- [ ] Re-encryption: `kubectl -n boilerplate create job --from=cronjob/boilerplate-reencrypt
      reencrypt-$(date +%s)` completes (the rotate-secrets runbook).
- [ ] Third-party providers you turned on, each with a real account once: Google
      sign-in, Stripe test mode, Twilio, push on real devices, the AI provider.

These, and what CI can't check in the app itself, are listed with how to check each in
[testing.md](testing.md#not-tested-automatically).

## 8. Releasing

[deploy.md](deploy.md), "Releases → production", and the release runbook
(`.claude/skills/release/SKILL.md`).

- [ ] The first release, on a commit that deployed to staging. Tag the merge once
      deploy.yml has passed for it (`gh run list --workflow deploy.yml --commit <sha>`),
      or the staging bump right after it. Not just any commit on `master`: one that
      never went through deploy.yml has no images, and tags can't be moved once pushed.
      `git tag v0.1.0 <commit> && git push origin v0.1.0`, then `bun run promote v0.1.0`
      to open production's promotion pull request.
