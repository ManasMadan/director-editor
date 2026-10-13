# Repository settings

What GitHub needs to be set to for the workflows in `.github/workflows` to gate, ship and
release as intended. Nothing here is needed to develop locally; do it once, when the
repository starts shipping.

## All of it from the command line

The sections below say what each setting is for; these `gh` commands apply them (run
them as the repository's admin, with `REPO` set to yours). Code scanning, which the
Security workflow uploads to and the ruleset gates on, is free on public repositories
only; a private one needs GitHub Code Security.

```sh
REPO=owner/name

# Public, and offered as a template for new projects (`gh repo create --template`).
gh repo edit "$REPO" --visibility public --accept-visibility-change-consequences --template

# Squash merges only, titled by the pull request: one commit per pull request keeps
# master's history linear. Head branches are deleted after merging.
# Auto-merge: a pull request set to merge does so once the ruleset's checks pass (`gh pr
# merge --auto --squash`, or the button). "Update branch" brings a behind one up to date,
# which the ruleset requires before merging.
# No wiki or projects: the docs live in this repository, and work in issues.
gh repo edit "$REPO" --enable-squash-merge --squash-merge-commit-message pr-title-description \
  --enable-rebase-merge=false --enable-merge-commit=false --delete-branch-on-merge \
  --enable-auto-merge --allow-update-branch --enable-wiki=false --enable-projects=false

# Workflows get read-only tokens unless a job asks for more, and never approve pull requests.
gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false

# Security: private vulnerability reporting, Dependabot alerts, secret scanning with push
# protection (the dependency graph is on for public repositories).
gh api -X PUT "repos/$REPO/private-vulnerability-reporting"
gh api -X PUT "repos/$REPO/vulnerability-alerts"
gh api -X PATCH "repos/$REPO" --input - <<'JSON'
{"security_and_analysis": {"secret_scanning": {"status": "enabled"},
  "secret_scanning_push_protection": {"status": "enabled"}}}
JSON

# Environments, deployable from master only. The drift ones hold the nightly plan's
# read-only credentials and need no approval: they only ever run master's code.
for env in staging infra-staging infra-production infra-staging-drift infra-production-drift; do
  gh api -X PUT "repos/$REPO/environments/$env" --input - <<'JSON'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
  gh api -X POST "repos/$REPO/environments/$env/deployment-branch-policies" -f name=master -f type=branch
done
# Applying production's infrastructure waits for your approval.
gh api -X PUT "repos/$REPO/environments/infra-production" --input - <<JSON
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true},
 "reviewers": [{"type": "User", "id": $(gh api user --jq .id)}]}
JSON
# Pull request plans run the pull request's OpenTofu code with the state's passphrase,
# from any branch, so each one waits for your approval.
for env in infra-staging-plan infra-production-plan; do
  gh api -X PUT "repos/$REPO/environments/$env" --input - <<JSON
{"reviewers": [{"type": "User", "id": $(gh api user --jq .id)}]}
JSON
done

# master: pull requests only, squash-merged once up to date with master, with each
# workflow's gate and CodeQL passing on that. Only the gates are required: each needs every other job of its workflow and
# always reports, so adding a job never needs a change here. APPROVALS is 0 for a single maintainer (GitHub doesn't let you approve your
# own pull request); make it 1 and CODE_OWNERS true once there's a team.
APPROVALS=0 CODE_OWNERS=false
gh api -X POST "repos/$REPO/rulesets" --input - <<JSON
{"name": "master", "target": "branch", "enforcement": "active",
 "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
 "rules": [
  {"type": "deletion"}, {"type": "non_fast_forward"},
  {"type": "pull_request", "parameters": {
    "required_approving_review_count": $APPROVALS, "require_code_owner_review": $CODE_OWNERS,
    "dismiss_stale_reviews_on_push": true, "require_last_push_approval": false,
    "required_review_thread_resolution": true, "allowed_merge_methods": ["squash"]}},
  {"type": "required_status_checks", "parameters": {"strict_required_status_checks_policy": true,
    "required_status_checks": [{"context": "CI passed"}, {"context": "Security passed"},
      {"context": "Kubernetes passed"}, {"context": "Infrastructure passed"}]}},
  {"type": "code_scanning", "parameters": {"code_scanning_tools": [
    {"tool": "CodeQL", "security_alerts_threshold": "high_or_higher", "alerts_threshold": "errors"}]}}
 ],
 "bypass_actors": []}
JSON

# Release tags can't be moved or deleted, except by an admin (a tag pushed by mistake).
gh api -X POST "repos/$REPO/rulesets" --input - <<'JSON'
{"name": "release tags", "target": "tag", "enforcement": "active",
 "conditions": {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}},
 "rules": [{"type": "deletion"}, {"type": "update"}, {"type": "non_fast_forward"}],
 "bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}]}
JSON
```

From here on every change reaches `master` through a pull request, and these can't be
undone by a command; to keep pushing straight to `master` for a while, leave the
`master` ruleset out until you're ready.

GitHub has no command that creates a GitHub App, but this opens its form filled in with
the permissions below (no webhook, only this account):

```sh
open "https://github.com/settings/apps/new?name=${REPO#*/}-bot-${REPO%/*}&url=https://github.com/$REPO&public=false&webhook_active=false&contents=write&pull_requests=write&issues=write&workflows=write&checks=read&statuses=read"
```

In the browser: **Create GitHub App** (the name must be unique on GitHub); note the
**App ID** (a number) and the **Client ID** (`Iv…`); **Generate a private key** (a
`.pem` downloads); **Install App** → **Only select repositories** → this one. Then:

```sh
APP_ID=123456                       # the App ID
CLIENT_ID=Iv23xxxxxxxxxxxx          # the Client ID
PEM=~/Downloads/<app name>.<date>.private-key.pem

gh variable set BOT_APP_CLIENT_ID --repo "$REPO" --body "$CLIENT_ID"
gh secret set BOT_APP_PRIVATE_KEY --repo "$REPO" < "$PEM"

# The App may push the staging bump past the master ruleset.
RULESET=$(gh api "repos/$REPO/rulesets" --jq '.[] | select(.name == "master") | .id')
gh api -X PUT "repos/$REPO/rulesets/$RULESET" --input - <<JSON
{"bypass_actors": [{"actor_id": $APP_ID, "actor_type": "Integration", "bypass_mode": "always"}]}
JSON

rm "$PEM"   # GitHub keeps the secret; don't leave the key lying around
```

To check: `gh api "repos/$REPO/rulesets" --jq '.[].name'` prints `master` and
`release tags`, and `gh variable list --repo "$REPO"` shows `BOT_APP_CLIENT_ID`.

## Merging

**Settings → General → Pull Requests**

- Allow **squash merging** only, with the default message set to **pull request title
  and description** (`pr-title-description` in the command above): the title is checked
  against Conventional Commits (the `pr-title` job), and it becomes the commit title the
  release notes are built from; the description becomes its body. A pull request must be
  up to date with master to merge (the ruleset's required checks are strict), so what
  lands is exactly what the checks passed.
- Enable **Automatically delete head branches**.

**Settings → Rules → Rulesets → New branch ruleset** for `master` (the default branch):

- Restrict deletions; block force pushes.
- Require a pull request before merging, with dismissal of stale approvals on new
  commits. With a single maintainer, 0 approvals and no code owner review (GitHub doesn't
  let you approve your own pull request; that's what the command above sets). Once
  there's a team, raise it here to 1 approval with **Require review from Code Owners**
  (`.github/CODEOWNERS`).
- Require status checks to pass: the four gates and nothing else. **CI passed**,
  **Security passed**, **Kubernetes passed** and **Infrastructure passed** each need every
  other job of their workflow (`ci.yml`, `security.yml`, `kind.yml`, `infra.yml`) and
  always report: Kubernetes and Infrastructure run on every pull request and skip their
  real work when nothing they check changed. So adding a job never needs a change here,
  and `scripts/workflows.test.ts` fails if a workflow that can block a pull request has
  no gate, or the ruleset here requires anything else.
- Require code scanning results: **CodeQL**, blocking on high or higher.
- Optional: **Require merge queue** (all four gated workflows run on `merge_group`;
  there the secrets scan and dependency review are skipped, which Security's gate counts
  as passing, since the pull request's own run already did them).
- Bypass list: the repository's GitHub App (below), so the staging bump can reach
  `master` without a pull request. Nobody else.

## The GitHub App

Workflows that write to the repository use a GitHub App's token instead of
`GITHUB_TOKEN`: pull requests opened with `GITHUB_TOKEN` never start CI (so dependency
pull requests could never pass **CI passed**), and `GITHUB_TOKEN` can't be put on the
ruleset's bypass list for the staging bump. Releases don't need it: you push the tag,
and `bun run promote` opens production's pull request as you. The same
App runs Renovate (`renovate.yml`, configured in `renovate.json5`).

1. **Settings → Developer settings → GitHub Apps → New GitHub App** (on your account or
   organization). No webhook. Repository permissions: **Contents**, **Pull requests**,
   **Issues** (Renovate's dependency dashboard) and **Workflows** (Renovate updates the
   pinned actions): Read and write; **Checks** and **Commit statuses**: Read. Only on
   this account.
2. Generate a private key, and install the App on this repository only.
3. In this repository: variable `BOT_APP_CLIENT_ID` (the App's client ID) and secret
   `BOT_APP_PRIVATE_KEY` (the key file's contents).
4. Add the App to the `master` ruleset's bypass list.
5. On the cluster hosting previews, Argo CD posts each preview's address on its pull
   request as the same App: its App ID, installation id (`gh api
   "repos/$REPO/installation" --jq .id`) and private key go in that environment's
   `argocd-notifications-secret` (`github-appID`, `github-installationID`,
   `github-privateKey`), a SOPS file in `deploy/platform/secrets/<env>/` (deploy/README.md).
   Do it before `rm "$PEM"` above.

Without the App the deploy workflow falls back to `GITHUB_TOKEN` and says so in a
warning, and Renovate doesn't run.

## Environments

**Settings → Environments**

| Environment | Used by | Protection |
|---|---|---|
| `staging` | `deploy.yml` (the staging bump) | deployment branch `master` |
| `infra-staging`, `infra-production` | `infra.yml` (apply, and plans run by hand) | required reviewers on production; deployment branch `master` |
| `infra-staging-plan`, `infra-production-plan` | `infra.yml` (plans on pull requests) | required reviewers; any branch |
| `infra-staging-drift`, `infra-production-drift` | `infra.yml` (the nightly drift check) | deployment branch `master`; no reviewers |

Production itself has no GitHub environment: it changes only by merging the promotion
pull request, which the ruleset already gates.

## Variables and secrets

**Settings → Secrets and variables → Actions.** Everything is optional; each feature is
skipped until its values exist.

| Name | Kind | For |
|---|---|---|
| `BOT_APP_CLIENT_ID`, `BOT_APP_PRIVATE_KEY` | variable, secret | the GitHub App above |
| `EVAL_MODEL` | variable | nightly evals against a real model, e.g. `anthropic:claude-sonnet-5` |
| `EVAL_EMBEDDINGS`, `EVAL_JUDGE_MODEL`, `EVAL_MIN_PASS_RATE`, `EVAL_MIN_RELEVANCE` | variables | the rest of the nightly evals' settings (`apps/ai/evals`) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | secrets | the providers those models use |
| `EAS_PROJECT_ID`, `EXPO_TOKEN` | variable, secret | mobile builds and over-the-air updates on EAS (`mobile.yml`; the project id from `bunx eas-cli init`, a robot token from expo.dev) |
| `LOAD_TARGET_RPS` | variable | the nightly load test's target (default 50 requests a second) |
| `STRIPE_CONTRACT_SECRET_KEY` | secret | the weekly check of the fake Stripe against Stripe's test mode (`stripe.yml`): a test-mode key (`sk_test_…`) of an account whose test-mode billing portal settings have been saved once (Dashboard → Settings → Billing → Customer portal); each run makes a customer with a trial subscription, then deletes it |
| `COSIGN_PRIVATE_KEY`, `COSIGN_PASSWORD` | secrets | signing images with a key pair instead of keyless, so production's admission doesn't depend on Sigstore's public services (docs/deploy.md) |
| `TOFU_TARGETS` | variable | which environments get a plan on infrastructure pull requests and the nightly drift check, e.g. `["staging", "production"]` |

Per `infra-<env>` environment, for `infra.yml` (see the header of that workflow and
`infra/tofu/README.md`), all secrets:

| Name | What |
|---|---|
| `TOFU_BACKEND` | the contents of `backend-<env>.hcl` (the state bucket and its keys) |
| `TOFU_TFVARS` | the contents of `<env>.tfvars` (the machines, domain, mail) |
| `SSH_PRIVATE_KEY` | the key the environment's machines accept |
| `CLOUDFLARE_API_TOKEN` | the zone's token (permissions in `infra/tofu/modules/cloudflare`) |
| `SOPS_AGE_KEY` | the environment's age private key, installed for Argo CD |
| `SOPS_PREVIEW_AGE_KEY` | on the environment hosting previews only: their own age private key |
| `TF_VAR_state_passphrase` | encrypts the state and plans |

A pull request's plan runs that pull request's OpenTofu code, so its environment,
`infra-<env>-plan`, holds only what a plan reads: `TOFU_TFVARS` and
`TF_VAR_state_passphrase` as above, a `TOFU_BACKEND` whose bucket keys can only read,
and a `CLOUDFLARE_API_TOKEN` with the read permissions of the ones listed in
`infra/tofu/modules/cloudflare`. Never the SSH key or an age key: only an apply uses
them. The passphrase still decrypts the state, which holds the cluster's admin key,
which is why each plan waits for a reviewer: read the pull request's changes to
`infra/tofu` before approving it. Pull requests from forks get no plan.

The nightly drift check plans master's code against each environment and opens the
issue "Infrastructure drift: <env>" when the plan has changes (closing it once a plan
is clean). Its environment, `infra-<env>-drift`, holds the same four secrets as the
plan environment, with the same read-only credentials, but only master deploys to it,
so it needs no reviewer and runs unattended. Without it, the drift check can't plan
and fails each night.

The runner connects to the machines over SSH and to the Kubernetes API (ports 22 and
6443): allow GitHub's runner addresses in the machines' firewall, or give the
environment a self-hosted runner inside your network.

## Security

**Settings → Advanced Security**

- Enable **Private vulnerability reporting** (`SECURITY.md` points reporters to it).
- Enable **Dependency graph** (dependency review needs it) and **Secret scanning** with
  **Push protection**.
- Code scanning is uploaded by `security.yml`; leave the default CodeQL setup off.

## Packages

Images are pushed to `ghcr.io/manasmadan/boilerplate/*` by `deploy.yml` and
`preview.yml`. After the first push, in each package's settings, link it to this
repository (**Manage Actions access → Write** for this repository) so later runs can
push, and choose its visibility. If the packages stay private, give the clusters a pull
secret and list it in the stack chart's `image.pullSecrets`.
