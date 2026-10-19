# Director — handoff (19 October 2026)

This branch (`handoff/mm/2026-10-19`) is never merged. It carries the working notes from a long build-and-fix
session so another agent can continue. Everything else is on `master` or on the branches listed below.

## The product and where it runs

Director (repo root `CLAUDE.md` explains the monorepo and commands) is a phone-first web app: Gemini Live coaches a
member shooting a YouTube Short, records the session continuously, cuts takes, and an editor renders the final video.
Production: https://director.mmadan.in on one GCE VM (k3s, Argo CD GitOps), GCP project
`project-18e15b18-c92e-44bb-9bf`, plus two Cloud Run services (`director-indexer`, `director-clipper`).

- Production runs **v1.7.2** (`sha-91ae921`). `master` is ahead: PR #52 (a saved video is whole or not saved) and
  PR #53 (demo terms and privacy) are merged but not deployed.
- Release flow: `gh workflow run deploy.yml --ref master` builds images → `git tag vX.Y.Z <sha> && git push origin
  vX.Y.Z` → `bun run promote vX.Y.Z` opens the promotion PR → merge it (admin) → Argo syncs, the migrate job runs.
  Then **redeploy both Cloud Run services on the same ai image every release** (docs/deploy.md, "The Cloud Run
  indexer"/"clipper"): mirror `ghcr.io/manasmadan/director-editor/ai:sha-<commit>` to
  `us-central1-docker.pkg.dev/<project>/director/ai:sha-<commit>` with `docker buildx imagetools create`, then
  `gcloud run deploy director-indexer --image=... --update-env-vars=RELEASE=sha-<commit>` and
  `gcloud run deploy director-clipper --image=...`. The worker ignores an indexer on another release (finding D2:
  automate this in deploy.yml).
- If a migration fails in production: the old migrate hook retries forever. Terminate the Argo operation, delete the
  job (remove its finalizer), `prisma migrate resolve --rolled-back <name>` from a one-off pod of the migrate image,
  then let the new release run (progress.md has the exact sequence used on 18 Oct).

## Owner rules (non-negotiable)

- Commits authored `Manas Madan <manasmadan08@gmail.com>`, Conventional with a workspace scope, first person,
  `--no-verify` is allowed; **never** mention AI/Claude/co-authors or add attribution lines. Branches
  `<type>/mm/<context>`. PRs are squash-merged with `--admin` (the owner has a permanent ruleset bypass).
- Never read or print `.env`; set secrets with `bun run env:set`. Never commit `.claude/settings.json`.
- Subagents always on Opus. Never use Codex for reviews.
- Log every finding immediately to a durable file (here: `findings.md`, `uat-open-issues.md`); owner-found bugs stay
  open until the owner re-tests them on a phone.
- The owner runs UAT now — don't run UAT agents unless asked. The product is a demo; terms say "as is", no liability.
- Owner decisions already taken: skip WebCodecs (keep the drain-and-verify save, #52); keep Live barge-in prefix
  padding at 400 ms (echo safety over the 0.3 s target); test writers paused, coverage later.

## What to do next, in order

1. **Finish and merge the four paused fix branches** (each pushed; the last commit on each is a `wip(...)` commit with
   the unfinished change — finish it, test it, fold or replace it):

   | Branch | Done on the branch | Left (see findings.md / uat runs) |
   |---|---|---|
   | `fix/mm/reviews` (clean vs master) | session-pass sizing, atomic asset claim, created plans never hang, lost queue adds re-queued, `VEO_ENABLED`, alignment settles reservation, indexing estimate, storyboard status | wip: bound the editor reply schema; proofreading + thought-token accounting; clipping ffmpeg cleanup |
   | `fix/mm/shoot-web` (clean) | whole line on the shot card (UI1-24), keep the take recording behind Leave? (UI1-23) | wip: ✕/back/title before Start (UI1-45); UAT1-17/18 empty takes + mid-recording codec change; UAT1-05/UI1-20 honest demo start card; UI1-51 landscape start card |
   | `fix/mm/ui-polish` (**conflicts**, rebase) | editor board, 44 px targets, sign-in and template pages, autosaved shots, member's poster, header/library at 360 px, post bottom sheet, plain bad-link copy | wip: YouTube link parser module; the rest of the UI1-xx list assigned in findings.md |
   | `fix/mm/perf` (**conflicts**, rebase) | editor renderer loaded on save, page data sooner, favicon/touch/manifest icons, unused fonts dropped | wip: defer captcha and demo card, lighter shoot start; the 945 ms long task right after "Start shooting" (reproduced: `tm` in one chunk takes 736 ms); LCP/TTFB (UI1-38), sign-in CLS (UI1-40), INP (UI1-41) |

   Keep checks fast (owner's instruction): lint, check-types and the single test files you touch; no whole suites.
2. **Release v1.7.3** with all of it (flow above), confirm the migrate job, `/api/v1/system` release, pods and
   error logs, and redeploy Cloud Run.
3. **Coverage** (later, when the owner says): `test/mm/coverage-api` (3 commits) and `test/mm/coverage-web-pages`
   (1 + wip) hold partial tests; `reviews/baseline-cov.txt` and `reviews/ci-green-report.md` list the files below 100%.
   CI's Coverage job is the only red job on master after PR #51.
4. **Follow-ups** in findings.md marked open: D2 (automate Cloud Run deploys), S10 migration minors, R13/R14,
   M1 ("use the second one" numbering), M3/M4 (stock errors, synthetic flag), UI1-19 (a 502 on "Talk it through").

## Workflow, step by step

### 0. A new machine: set up access first

- Repo: `git clone https://github.com/ManasMadan/director-editor && cd director-editor && bun run setup`
  (installs, generates, starts local Postgres/Valkey/Mailpit in Docker). `bun run doctor` checks it. `.env` is not in
  git: get it from the owner, or set each value with `bun run env:set KEY=value` (never read or print `.env`).
- GitHub: `gh auth login` as an account with admin on ManasMadan/director-editor. If git keeps asking for a password
  or uses another credential store, push with the gh helper:
  `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push -u origin <branch>`.
  For scripts that call git internally (`bun run promote`), set it through the environment:
  `GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1='!gh auth git-credential'`.
  Add `HUSKY=0` and `--no-verify` when a local hook blocks (hooks run tests that need local services).
- Google Cloud: `gcloud auth login` (a project owner) and `gcloud config set project project-18e15b18-c92e-44bb-9bf`.
  `gcloud auth configure-docker us-central1-docker.pkg.dev` for the Cloud Run image mirror. Docker with buildx.
- Kubernetes: production's kubeconfig lives at `~/.kube/director-editor-production` on the owner's Mac; copy it (ask
  the owner) and `export KUBECONFIG=~/.kube/director-editor-production`. The API server (6443) and SSH (22) are only
  open to allow-listed IPs through the GCE firewall rule `director-admin`; add the new machine's public IP:
  `gcloud compute firewall-rules update director-admin --source-ranges=<existing>,<new-ip>/32` (check the current
  ranges with `describe` first and keep the owner's). SSH: `gcloud compute ssh director-1 --zone us-central1-a`.
- SOPS secrets (deploy/platform/secrets): the age key is at `~/.config/director-editor/production.agekey` on the
  owner's Mac, used as `SOPS_AGE_KEY_FILE=...`. Internal tool passwords (Argo CD, Grafana, …) are in
  `~/.config/director-editor/internal-tools.txt` on the owner's Mac; ask the owner. Tools: argocd/grafana/jaeger/
  prometheus/alertmanager `.director.mmadan.in` behind one shared HTTP login.

### 1. Work on a branch

- Branch from fresh master: `git fetch origin && git switch -c fix/mm/<context> origin/master`.
  To continue a paused branch: `git switch -c <branch> origin/<branch>` then `git rebase origin/master`.
- Never `git stash`, never `git worktree add` by hand (use `wt switch --create <branch>` for parallel work), never
  commit `.claude/settings.json` (it often shows as modified; leave it unstaged, never `git commit -a`).
- Generated files (`**/generated/**`, `openapi.json`, `apps/ai/app/contracts/`, `en.d.json.ts`) are never edited:
  change the source and run `bun run gen`. On a rebase conflict in them, take master's copy and re-run `bun run gen`.
- Migrations: new folder under `packages/db/prisma/migrations/` with a timestamp **after every existing one**
  (the latest on master is `20261019060000_*`; check `ls` first), expand-only, RLS + grants, one
  `CREATE INDEX CONCURRENTLY` per migration file. Never edit a migration that has applied in production.
  `bun test packages/db` includes a guard against reusing a policy name on the same table.

### 2. Check (fast, per the owner)

`bun run lint`, `bun run check-types`, and the single test files you touched
(`bun run --filter @repo/web test -- <file>`, `bun run --filter @repo/api test -- <file>`, Python:
`bun run --filter @repo/ai test -- tests/<file>.py`). Skip whole suites and coverage unless asked. The machine's
Docker services: `bun run db:up` / `bun run db:down`; a separate stack per parallel agent with
`bun run setup --stack <n>`.

### 3. Commit, push, PR, merge

```sh
git add <files>          # never -a
git commit --no-verify -m "fix(web): the shot card shows the whole line"   # Conventional, scope = workspace, first person, no AI mentions
HUSKY=0 git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push --no-verify -u origin <branch>
gh pr create -R ManasMadan/director-editor --base master --head <branch> \
  --title "fix(web): ..." --body "What changed and why, in plain prose. No headers or checklists, no AI mentions."
gh pr merge <branch> -R ManasMadan/director-editor --squash --admin
```
- Before merging: `git fetch origin && git merge-tree --write-tree --name-only origin/master origin/<branch>` must
  exit 0 (no conflicts); otherwise rebase the branch first.
- A breaking API change needs `!` in the PR title (`feat(api)!: ...`); CI's api-compat job checks it.
- After a squash-merge, continuing work on the same branch: `git rebase --onto origin/master <sha-that-was-merged>`
  (drops the already-merged commits), then `push --force-with-lease`.
- CI (GitHub Actions `ci.yml`) runs on PRs and master; every job passes on master except Coverage (see step 3 of
  "What to do next"). Today's PRs were merged without waiting for CI, by the owner's call; prefer waiting for CI
  when there's time (`gh pr checks <n> --watch`).

### 4. Release and deploy

```sh
git fetch origin && M=$(git rev-parse origin/master)
gh workflow run deploy.yml -R ManasMadan/director-editor --ref master        # builds + signs all images for $M
gh run list -R ManasMadan/director-editor -w deploy.yml -L 3                  # take the workflow_dispatch run id
gh run watch <run-id> -R ManasMadan/director-editor --exit-status
git tag vX.Y.Z $M && git push origin vX.Y.Z                                   # release.yml publishes notes from commits
HUSKY=0 GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= \
  GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1='!gh auth git-credential' bun run promote vX.Y.Z
gh pr merge <promotion PR> -R ManasMadan/director-editor --squash --admin    # production moves when this merges
```
Then watch it land:
```sh
export KUBECONFIG=~/.kube/director-editor-production
kubectl -n argocd annotate application production-root argocd.argoproj.io/refresh=normal --overwrite
kubectl -n argocd get application production-stack -o jsonpath='{.spec.sources[0].targetRevision} {.status.operationState.phase}'
kubectl -n director-editor get jobs --sort-by=.metadata.creationTimestamp | grep migrate | tail -1
kubectl -n director-editor logs job/<migrate job> --tail=20
curl -s https://director.mmadan.in/api/v1/system      # "release":"sha-<commit>" when live
kubectl -n director-editor get pods
kubectl -n director-editor logs deploy/director-editor-<api|worker|ai|ai-worker|web> --since=10m | grep '"level":"error"'
```
"OutOfSync Healthy" on production-stack is normal (known Kyverno digest drift); the operation phase must be
`Succeeded`. Versions so far: v1.0.0 … v1.7.2; next is v1.7.3.

Then redeploy Cloud Run on the same image (every release):
```sh
PROJECT=project-18e15b18-c92e-44bb-9bf; REGION=us-central1; COMMIT=<full sha of the release>
IMAGE=$REGION-docker.pkg.dev/$PROJECT/director/ai:sha-$COMMIT
docker buildx imagetools create --tag $IMAGE ghcr.io/manasmadan/director-editor/ai:sha-$COMMIT
gcloud run deploy director-indexer --project=$PROJECT --region=$REGION --image=$IMAGE --update-env-vars=RELEASE=sha-$COMMIT --quiet
gcloud run deploy director-clipper --project=$PROJECT --region=$REGION --image=$IMAGE --quiet
```
New env vars go in the service's `src/env.ts` (or `apps/ai/app/settings.py`), `.env.example`,
`docs/environment.md`, and production values in `deploy/environments/production/stack.yaml` (secrets via SOPS).

### 5. When something breaks in production

- Failed migration (P3009): see "If a migration fails" above; the exact commands are in progress.md (18 Oct, v1.4.1).
  The one-off resolve job is the migrate job's spec with args
  `["/app/node_modules/prisma/build/index.js","migrate","resolve","--rolled-back","<migration>"]`.
- Read-only database look: `kubectl -n director-editor exec director-editor-postgres-1 -c postgres -- psql -U postgres -d app -c "<select>"`
  (never write without the owner's say-so). Locally, the `postgres` MCP server is read-only on the local DB.
- A live Gemini check from production: run Python inside the ai pod (`kubectl exec ... -- sh -c 'cd /app && python ...'`);
  it has Vertex credentials through the VM's service account (the api image has no shell).
- Storage cleanup runs hourly in the worker (files-cleanup at :30, demo-retention at :20); its queue is
  `files.object_deletion`. Bucket: `gs://director-media-1053522546520` (lifecycle: recordings/ 15 days, director/speech/ 90 days).
- Rollback: promote the previous tag (`bun run promote v1.7.1`). Don't roll back past v1.6.0 (finding S9).

## The files here

- `progress.md` — the chronological ledger of everything done (releases, merges, incidents, rulings).
- `findings.md` — every finding with ID, severity, source and status (B=blockers, L=Live, R=reviews/AI,
  S=security/migrations, F=frontend, E=export, P=prod ops, UAT1/UI1=UAT runs, D=deploy, Q=owner questions).
- `uat-open-issues.md` — the owner's bugs U1–U8 (fixes live; awaiting the owner's phone re-test).
- `uat/` — UAT run 1 (`uat-run-1.md`), the UI pass (`uat-ui-run-1.md`), the scripts and quality bar, and the owner's
  checklist (`owner-uat-checklist.md`). Screenshots and raw footage were not copied (they show the owner).
- `reviews/` — the five code reviews (security, migrations, python, api, frontend), the Live investigation, and every
  fixer's report.
- `v2-*.md`, `task-*.md` — earlier slice briefs and reports; the product spec is
  `docs/superpowers/specs/2026-10-18-director-ux-redesign.md` on master.
