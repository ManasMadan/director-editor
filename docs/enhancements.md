# Enhancements

What the template doesn't do yet but could. Each one was left out for a reason, written
down here with what it would take, so whoever picks it up starts from the trade-off
rather than from scratch.

## A shared build cache for CI

Turborepo can share task results between machines through a remote cache, so a CI job
skips any package another run already built and tested. CI uses GitHub's own cache per
job today (`.github/actions/setup`, plus the type-check, Storybook and ClamAV caches in
`ci.yml`), which covers most of it.

Not done because everything here is self-hosted: a remote cache in the cluster would
have to be reachable from GitHub's hosted runners, which means putting an internal
service and its token on the internet just for CI.

To do it: run a self-hosted Turborepo cache server (an S3-backed one, on RustFS) behind
the gateway with a long random token, set `TURBO_API`, `TURBO_TEAM` and `TURBO_TOKEN`
in the workflows, and add the endpoint to the jobs' egress lists. Self-hosted runners in
the cluster would avoid the exposure altogether, and would also make the cache local.

## Argo CD in the local cluster

`bun run k8s:up` installs the charts on kind directly with Helm, KEDA included. The
clusters instead get everything from Argo CD's ApplicationSets, which decrypt their
secrets with the SOPS plugin. That path is checked by rendering (`bun run charts:check`)
but never runs end to end before staging.

Not done because the ApplicationSets deploy from the repository on GitHub, at the
default branch's head, so a kind run would test master rather than the change in front
of you; and it needs an age key and decrypted secrets for a throwaway cluster.

To do it: point a kind-only ApplicationSet at a git server inside the cluster (or Argo
CD's local directory source) loaded from the checkout, generate an age key per kind
cluster in `k8s:up`, and encrypt the generated local secrets with it, then wait for
every Application to be healthy instead of installing the charts by hand.

## Fixing CI on its own

The opt-in Claude Code review (`.github/workflows/claude-review.yml`) only reads and
comments. A second workflow could react to a failed CI run on a pull request: read the
failing job's log, fix the cause and push a commit to the branch.

Not done because it needs write access to the repository and pushes code nobody has
looked at yet, which is the owner's call, not the template's default.

To do it: a workflow on `workflow_run` (CI, failed) for same-repository pull requests,
gated by its own repository variable like `CLAUDE_REVIEW`, with `contents: write` for
that job only, `claude-code-action` pinned by digest, and the hooks and test suites
available on the runner (Bun installed), so its commits pass the same checks as anyone
else's. Limit it to one attempt per failure, so it can't loop.

## Blocking egress in every CI job

Every job runs `step-security/harden-runner` first. The jobs whose traffic is known
(`changes`, `pr-title`, `ci-ok` and the weekly Stripe check) block anything outside
their allowlists; the others only audit.

Not done because each remaining job's real destinations (Docker Hub, ghcr.io, quay.io,
PyPI and uv, Playwright's browser downloads, ClamAV's signature mirror, Helm
repositories, the OpenTofu registry) have to come from what it actually called, not
from a guess, or the first run after switching fails.

To do it: for each job, open a recent run on master, follow the harden-runner link in
its summary, copy the endpoints it lists into `allowed-endpoints`, and switch the job to
`egress-policy: block` (`.claude/rules/ci.md` has the steps; `scripts/workflows.test.ts`
checks the list's format).

## Claude Code's sandbox

Claude Code can run its shell commands in a sandbox that limits what they read, write
and reach on the network. It's off here (`CLAUDE.md`), and the hooks in `.claude/hooks`
guard the risky commands instead.

Not done because the everyday commands need what a sandbox takes away: Docker's socket
for the local services, localhost ports for the apps and tests, and the network for
installs.

To do it: turn the sandbox on in `.claude/settings.json` with Docker's socket allowed,
`docker` and `docker compose` listed as commands that run outside it, localhost and the
package registries allowed on the network, and the hooks kept as they are; then run a
full `bun run dev`, `bun run test:integration` and an e2e run under it to find what it
still blocks before making it the default.

## Search

There is no search across a workspace's own data (todos, documents, files). The AI
service's pgvector search covers the assistant's passages, which is a different job.

Not done because what to search, and how results should rank, depends on the product
built on the template; a generic search over every table would mostly be in the way.

To do it: start with Postgres full-text search, a generated `tsvector` column with a GIN
index on each table worth searching, queried inside the tenant context so row-level
security still applies. Add a `search` procedure to the contracts, a client hook and a
command palette in the web and mobile shells. Move to a dedicated engine only once
Postgres measurably can't keep up.
