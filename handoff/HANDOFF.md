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
