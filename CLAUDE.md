# Boilerplate

Full-stack monorepo: a hackathon starter built to production standards. Everything is
driven by `bun` scripts, and every common task has a skill in `.claude/skills/`.

## Commands

| Task | Command |
|---|---|
| First-time setup (idempotent) | `bun run setup` |
| Health check (tools, .env drift, services) | `bun run doctor` |
| Develop (core profile: web, api, notifications, worker, webhooks) | `bun dev` |
| Develop with every service (AI and its worker, RustFS, ClamAV, Stalwart, Jaeger, Expo, email previews) | `bun dev:full` |
| Lint, formatting, architecture boundaries | `bun run lint` (`bun run format` to fix) |
| Types | `bun run check-types`; no `any` and no casts in the source: `bun run type-coverage [<workspace>]` |
| Unit tests (fast, cached) | `bun run test` |
| Integration tests (real Postgres/Valkey/Mailpit) | `bun run test:integration` |
| Coverage: every suite merged, every file at 100% (needs the full profile) | `bun run test:coverage` |
| Tests of `scripts/`, the Claude Code hooks and the rest of the tooling (build scripts, generators, load test) | `bun test ./scripts/ ./.claude/hooks/` |
| Every check that applies to a change | the `verify` skill |
| Look at the running app in a browser (Playwright CLI) | `playwright-cli -s=<task> open --browser=chromium <url>` (Playwright's `playwright-cli` skill) |
| Regenerate code (Prisma client, API/AI clients) | `bun run gen` |
| New database migration | `bun run db:migrate` |
| Work on another branch in parallel (its own worktree, sharing the local services) | `wt switch --create <branch>` (`wt list` shows them) |
| Set a secret in .env (never read or print it: the Read tool refuses, and so must you) | `bun run env:set KEY=value` (`env:unset KEY` removes one) |

Run commands from the repo root. Never `cd` into a package to run tools directly; for one
package use `bun run --filter @repo/<name> <script>` (or `bun run --cwd <dir> <script>`).

Local services (Docker, host ports): Postgres 55432, Valkey 56379, Mailpit 58025 (SMTP
51025); with `full`, RustFS 59000 (console 59001), ClamAV 53310 and Jaeger (OTLP 54318,
UI 56686); the Stalwart mail server (`bun run db:up:mail`, and in `full`): submission
51465, management 58080. Web is on 3000, api 3001, worker 3002, notifications 3003,
webhooks 3004, ai 8000; with `bun dev:full`, the email previews 3030 and Expo's bundler
8081. On demand: fake Stripe 12111 (`bun run stripe:fake`), the mobile web build 3005
(`serve:web`, used by e2e), Storybook 6006. Those are the defaults: each is a `*_PORT` in
`.env` (`WEB_PORT`, `API_PORT`, ...), and nothing else may fix a local port
(`scripts/ports.test.ts`). Uploads stay off until `S3_BUCKET` is set,
and billing until the Stripe variables are (docs/files-and-billing.md), even with
`dev:full`.

## Principles (non-negotiable)

1. **Fix root causes.** No workarounds, no `as any`, no `@ts-ignore`, no disabling a
   lint rule to get green. If the design forces a workaround, change the design. A fix
   also lands with whatever stops it coming back (a test, a lint rule, a check or a
   hook), so the checks catch it next time instead of someone reading the code.
2. **Validate at every boundary**: env (t3-env), HTTP input (contract schemas), queue
   payloads (`parseJob`), cross-service data. Types come from schemas, never duplicated.
3. **One implementation per concern.** Before writing a helper, search `packages/` for it.
4. **Seams, not rewrites.** Integrations that will change at scale (translations,
   templates, email/SMS/push providers, storage, search, queues) sit behind one
   interface. Call the interface, never the provider. Each seam's file documents how to
   swap it; the full list is in README "Scaling path".
5. **Services never import each other.** They share `packages/*` and talk through the
   API contract, queues and events. `bun run lint:boundaries` enforces this.
6. **Every user-facing string goes through `packages/i18n`** (UI, emails, push, SMS).
7. Comments explain *why*, in plain prose. No decision IDs, no "as discussed".

## Layout

- `apps/web` Next.js, render-only (no route handlers or server actions; enforced)
- `apps/api` NestJS on Fastify: auth (better-auth) and the oRPC API
- `apps/notifications` NestJS worker: every notification channel
- `apps/worker` NestJS: outbox relay, audit log, scheduled jobs
- `apps/webhooks` NestJS: inbound provider webhooks and outbound delivery
- `apps/ai` Python (FastAPI, Pydantic AI, LangGraph, BullMQ worker)
- `apps/mobile` Expo
- `packages/contracts` API contract, input schemas, limits, error codes
- `packages/client` data hooks for web and mobile (the only way apps call the API)
- `packages/db` Prisma schema, migrations, client factory
- `packages/nest-common` shared Nest plumbing (env fragments, db, redis, logging, health,
  outbox, `safeFetch`, rate limits, encryption, storage)
- `packages/jobs` queue contracts and producer
- `packages/i18n` every translation; `packages/email` email templates; `packages/ui` components

## Working rules

- Libraries change faster than your training data. For Next.js, Turborepo and other tools
  that bundle docs, read the installed version's docs first:
  `node_modules/next/dist/docs/`, `node_modules/turbo/docs/`.
- Generated files (`**/generated/**`, `*.gen.ts`, `openapi.json`, `apps/ai/app/contracts/`),
  shipped migrations, lockfiles, SOPS files and `.env` are never edited by hand: the edit
  and Bash guards refuse them (`.claude/hooks/file-rules.ts`), and ask the user before
  Claude changes its own guard rails (hooks, settings, commit hooks, lint rules). Change
  the source and regenerate. A new suppression, skipped or focused test, or coverage
  pragma is refused too, unless docs/testing.md lists it with its reason.
- When you finish a change, the Stop hook runs the fast checks on what changed and sends
  you back to fix what fails; what it runs, its limits and when it asks for the full
  checks are in one place, the header of `.claude/hooks/verify-turn.ts`. It doesn't run
  the boundary checks, integration or e2e tests: for anything touching the database,
  queues or HTTP, run the `verify` skill.
- Long-running commands go in the background (the Bash tool's `run_in_background`),
  never in the foreground: `bun dev` and `bun dev:full` never exit, and
  `test:integration`, `test:coverage`, `test:e2e`, `charts:check` and
  `bun scripts/generators.ts` take longer than the tool's two-minute default. Wait for
  them to finish before reporting a result.
- Commits: Conventional Commits with a workspace scope, e.g. `feat(api): add todo sharing`.
- New environment variables go in the service's `src/env.ts`, `.env.example`, and
  docs/environment.md, in the same change.

## Claude Code setup

- `.claude/rules/`: per-area rules that load when you open matching files (api,
  contracts, client, web, ui, mobile, db, jobs and events, notifications, python, infra,
  ci, scripts, generators, tests, i18n, security, docs, the Claude setup itself, and
  coding standards for every TypeScript and Python file). Each app and `packages/db`
  also has its own `CLAUDE.md`.
- `.claude/agents/`: reviewers that read and never edit (`reviewer`,
  `security-reviewer`, `migration-reviewer`, `python-reviewer`, `frontend-reviewer`,
  `i18n-checker`, `ci-triager`), `verifier` (runs the checks), `test-writer` (adds tests,
  raises coverage) and `docs-sync` (fixes docs that drifted). Each skill ends by naming
  the ones to run; run them before calling a change done.
- `.claude/skills/`: step-by-step procedures, also the humans' runbooks
  (`docs/README.md` lists them). The `swap-*` skills, releases, rollbacks, secret
  rotation, opening a pull request, adding an app and removing a feature are started by
  the user (`/<name>`), never on your own.
- `.claude/settings.json`: Bash commands run without a prompt only when listed (named
  `bun run` scripts, the repo's tools, read-only git and gh); the Bash guard hook asks
  before commits, pushes, GitHub changes, infrastructure, destructive scripts, stopping
  or deleting Docker containers, volumes or images, new
  dependencies and a `bunx` tool that isn't installed. Secrets files (`.env`, keys,
  tfvars and tfstate, load-test sessions) are denied to the Read tool; a shell command
  could still print them, so never try. There is no sandbox: Docker and the local
  services need the socket and the network.
- `.claude/hooks/`: the Stop hook runs the fast checks on what the turn changed,
  including the unit coverage of the changed lines; a reviewer or the verifier that
  ends without its verdict is sent back, and a verdict that isn't a pass is put in front
  of you; after a compaction you're told which files the tree changes. The Stop hook
  can't tell two sessions' edits apart, so run one session per checkout and a worktree
  for the next.
- `.claude-plugin/`: the same skills, agents and hooks as a plugin, for apps made from
  this template (`docs/new-project.md`); a new agent or hook goes in `plugin.json` too.
- Plugins (`enabledPlugins`): Worktrunk, and from Anthropic's marketplace
  `typescript-lsp` and `pyright-lsp` (code intelligence), `expo`, `stripe`,
  `redis-development`, `terraform` and `security-guidance` (edit warnings and a
  background review of each turn and commit). `.claude/rules/claude-setup.md` says what
  each needs; none needs an account here. Install each once with
  `claude plugin install <name>@claude-plugins-official --scope project`.
- Worktrees: parallel branches and agents use Worktrunk (`wt`, `.config/wt.toml`), whose
  Claude Code plugin settings.json enables: an agent started with `isolation: worktree`
  gets one through `wt switch --create`, with `.env` copied (`.worktreeinclude`),
  dependencies installed and code generated. Never `git stash` (every worktree shares
  one stash stack) and never `git worktree add` by hand. The worktrees share the
  Docker services and the app ports unless one runs `bun run setup --stack <n>` (its own
  compose project, and every service and app port moved; `docs/environment.md`): then
  each runs its own `bun dev` and e2e suite at the same time. `wt merge` and `wt remove`
  ask first.
- Browser: Playwright's own skills, `playwright-cli` (drive a browser from the shell)
  and `playwright-trace` (read a failed e2e test's trace), installed by Playwright's
  commands from the root `playwright-core`, the e2e suites' version. Never edit them:
  Renovate's Playwright updates reinstall them, and `scripts/playwright.test.ts` fails
  and prints the commands if they drift. The session-start hook puts `.claude/bin` on the shell's PATH
  for the `playwright-cli` command. Here, name the session after the task
  (`-s=<task>`) so two agents never share a browser, pass `--browser=chromium` for the
  e2e suites' Chromium, and sign in as a seeded user (docs/database.md). Snapshots go
  to `.playwright-cli/`, which git ignores. A flow that must keep working becomes an
  e2e spec (the write-tests skill).
- `.mcp.json`: Postgres on the local `app` database (`scripts/mcp-postgres.ts`). It
  connects as `app_readonly`, a role that exists only in the local database
  (`infra/postgres/init/02-readonly-role.sql`): read-only, and past row-level security,
  so it sees every workspace's rows for debugging; nothing it runs can write. Use it for data, schemas, indexes and query plans. It needs `uv` and
  the local services: if Postgres isn't up it says so at once; start it with
  `bun run db:up`, then reconnect with `/mcp`.
