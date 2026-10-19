# How every implementer works on this build

The repo is director-editor, being turned into "Director" for a Google Cloud hackathon:
users pick a YouTube Short, Gemini (on Vertex AI) breaks it into shots, they shoot their
own take of each shot with Gemini directing over a live video call, edit the takes on a
timeline and publish to YouTube Shorts.

## Setup (first thing)

Your worktree may start from the wrong commit. Point your branch at the integration
branch before anything else:

    git fetch origin
    git checkout -B "$(git branch --show-current)" origin/feat/mm/director-hackathon

Then `bun install`, `uv sync --project apps/ai` and `bun run gen`. Never `git stash`
(every worktree shares the stack); never `git worktree add` by hand.

## Rules (binding)

- Read `CLAUDE.md`, the app's own `CLAUDE.md`, and the `.claude/rules/*.md` for every
  area you touch before writing code. They are binding: contracts-first, RLS through
  `tenant`/`withTenant`, expand/contract migrations, every user-facing string through
  `packages/i18n` (en only), no `any`/casts/`# type: ignore`/new suppressions (unless
  `docs/testing.md` lists them with a reason), 100% coverage, every env var in the
  service's settings + `.env.example` + `docs/environment.md` together, a helm-unittest
  case for every chart change.
- No hard-coding, fakes, mocks or stubs anywhere except tests. The running app uses real
  Google services. `packages/fake-google` and other fakes are test fixtures only.
- Every loading/waiting state uses `GeminiLoader`/`GeminiShimmer` from `packages/ui`
  (label required, translated), never a plain spinner.
- TDD: write the failing test first, see it fail, then the code.
- Never print or read a secret; never read `.env` (set non-secret values with
  `bun run env:set KEY=value` only when the brief says so).
- Don't start, stop or restart the owner's running dev stack, and don't touch Docker
  containers you didn't start. Integration tests start their own services through the
  repo's commands.
- You never dispatch subagents (no helpers, no reviewers). Review comes from the
  controller after your report.

## Committing

The owner has authorized commits on this repo without asking (2026-10-18). Commit your
work on your worktree branch in Conventional Commits with a workspace scope
(`feat(api): ...`), first person, plain prose, and never mention Claude, AI assistants
or add attribution/Co-authored-by/Claude-Session trailers. Use `git commit --no-verify`
(the local hooks take many minutes; you run the checks yourself). Don't push and don't
merge. If a guard refuses the commit, leave the work uncommitted and say so.

## Your own service stack

Several agents work at once and share the default local Postgres/Redis, which makes
integration tests flaky (another worker drains the shared queue). Before running
integration or coverage suites, give your worktree its own stack with
`bun run setup --stack <n>` (the dispatch gives you `<n>`; docs/environment.md explains
stacks), and stop it when done (`bun run db:down` in your worktree). Never stop
containers you didn't start.

## Checks before you report

Run every check that applies to what you changed and include the commands and the tail
of their output in your report: `bun run lint`, `bun run check-types`, `bun run test`,
`bun test ./scripts/ ./.claude/hooks/` (if you touched scripts/tooling),
`bun run test:integration` for the packages you touched (in the background; it is long),
`bun run --filter @repo/ai test` and the ai integration tests for apps/ai changes,
`bun run charts:check` for deploy/ changes, `bun run gen` drift-free. Coverage must stay
at 100% for files you touched (`bun run --filter @repo/<name> coverage && bun
scripts/coverage.ts`).

## Report

Write the full report to the report path in your dispatch (if a guard refuses it, write
it at the same relative path inside your worktree and say so): what changed and why,
the commits, every command with its output tail, TDD evidence (the failing run first),
and anything you decided that the brief didn't. Return only: status (DONE |
DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED), commit range, a one-line test summary and
concerns.
