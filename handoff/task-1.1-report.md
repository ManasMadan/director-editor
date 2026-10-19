# Tasks 1.1 and 1.2: remove starter features, rebrand to Director

SESSIONS PATH: .fuzz/sessions.json

Worktree: `/Users/manas.madan/Desktop/code/director-editor/.claude/worktrees/agent-a9fdb727612853395`
Branch: `worktree-agent-a9fdb727612853395` (base `b6dc913`, not pushed)

(Written here because the worktree guard refused the shared checkout's
`.superpowers/sdd/...` path; copy it over. It is untracked, not committed.)

## Commits (b6dc913..4985682)

| Commit | What |
|---|---|
| `323b085` feat(api)! | MCP servers, better-auth mcp/jwt/cimd plugins, OAuth consent, connected apps |
| `716dc78` feat(ai)! | documents assistant, RAG, embeddings, chunking, summaries, sentiment, Python MCP server, ai-ingest queue, CI evals |
| `c2e77ae` chore(mobile)! | apps/mobile, mobile.yml, load/ (k6), their rule and skills, the release script's mobile version check |
| `801c7e3` feat(db)! | Prisma models dropped; migration `20261018120000_remove_starter_features`; db tests now use short reactions; drift's pgvector skip removed |
| `da74b51` feat(notifications)! | email only (sign-in codes, security alerts); SMS, push, inbox, preferences, quiet hours, digest gone; queues trimmed |
| `7936136` feat(api)! | todos, billing/Stripe (plus fake-stripe and stripe.yml), API keys and scopes, outbound webhooks, audit procedures, notification settings, phone numbers, push devices; one member per workspace; SecretBox and signed tokens removed along with their only users |
| `1a5499d` feat(web)! | "Director" rebrand, /library home, workspace UI and removed pages gone (404), language menu gone, `es` catalog gone, e2e smoke for leftover "Director-editor" text |
| `4985682` chore(repo) | .env.example, docs/environment.md, CI, k8s/image smoke, stack values, knip, generator, pre-push, rules, skills, READMEs, CLAUDE.md |

The first try at the mobile/load-test commit was denied by mistake. I redid it and it is
`c2e77ae`. Before that, the denied commit's staged files had slipped into an earlier
version of the db commit. I reset my own unpushed commits with `git reset --mixed`,
which leaves the working tree as it was, and regrouped them into the commits above.

## Removed

- Todos and `/dashboard`.
- Documents assistant, RAG and sentiment, with `ai.document`, `ai.chunk` and the ai-ingest queue.
- MCP servers, better-auth's mcp, jwt and cimd plugins, and the OAuth tables.
- Billing:
  - Stripe, entitlements, fake-stripe, `/webhooks/stripe`, the billing schema, stripe.yml and the billing settings.
  - `billing.entitlements()` is replaced by `WORKSPACE_MEMBER_LIMIT = 1` in `packages/contracts/src/auth-settings.ts`. It is enforced by better-auth's `membershipLimit` plus a `beforeCreateInvitation` check that counts members and pending invitations.
- API keys: the plugin, `auth.api_key`, scopes, the settings page and the API-key middleware.
- Outbound webhooks:
  - The module, contracts and settings.
  - The `webhooks.endpoint` and `webhooks.delivery` tables.
  - The two queues.
- SMS, push (VAPID, FCM, APNs, Twilio), the in-app inbox, preferences, quiet hours, the digest, unsubscribe links and phone numbers.
- The audit log UI and procedures. The pipeline into `audit.audit_log` stays, and so do the event labels.
- apps/mobile, mobile.yml, mobile-only auth (mobile sign-in, app origins, Android passkey origins), the `.well-known` routes, the mobile captcha return page and load/.
- The `es` locale and the header language switcher. PreferenceSync now syncs only the time zone.
- Skills:
  - add-api-key-scope, add-entitlement, add-load-test, add-mobile-screen, add-mcp-tool.
  - swap-push-provider, swap-sms-provider, swap-secrets-encryption, swap-llm, swap-embeddings, swap-document-search.
- Rules: `rules/mobile.md`.

## Kept

- Auth:
  - Email and password, email OTP through the notifications email channel, and the Google sign-in config.
  - 2FA, passkeys and captcha.
- Workspaces: the personal workspace made at sign-up (the model stays, the UI is hidden), the `inOrg` procedures, and the `orgAdmin` builder, which is still defined but unused.
- Files and uploads, with the ClamAV worker.
- AI:
  - apps/ai with Director, and packages/ai-client.
  - `callAi` and `aiCaller` in apps/api/src/modules/ai.
  - `AiUsage` and usage.py, and the `ai` feature flag.
- The Shorts module.
- The webhooks app with the Stalwart route.
- Realtime (`files.changed`, `director.changed`).
- The audit pipeline, and the event names (so the events-compat check still passes).
- The `load-users` command, because the fuzzing reads its sessions file.

## Rebrand and routing (1.2)

- "Director" is now the name in every user-facing place:
  - common.appName, meta, the home copy and page titles (`%s · Director`).
  - better-auth's appName, the 2FA issuer and the passkey rpName.
  - The manifest (start URL `/library`), the email layout and the `EMAIL_FROM` defaults and examples.
- `HOME_PATH = "/library"` (in `apps/web/src/lib/routes.ts`) renders the Shorts home. `/home` is folded into it, and sign-in and sign-up both land there.
- These routes now return 404, which the e2e test `workspace pages are gone` checks: workspace settings, members, invitations, dashboard, notifications, billing, API keys, webhooks and audit.
- The landing page `/` stays public:
  - The page never redirected.
  - The proxy only sends APP_PATHS to sign-in and signed-in GUEST_PATHS to `/library`, and `/` is in neither.
  - A new e2e test, `the landing page stays public, signed in or not`, covers it.
- A new e2e smoke test checks that no "Director-editor" text appears in the title or body of `/`, `/sign-in` or `/library`.

## Migration

`20261018120000_remove_starter_features`:

- Drops `auth.mcp_grant_active`, `notifications.register_device` and `notifications.users_with_digest_items`.
- Redefines `auth.purge_expired`, `notifications.purge_history` and `webhooks.purge_history` over the remaining tables. Their names and grants are unchanged, so the worker keeps calling them.
- Revokes:
  - USAGE on the auth schema from app_ai.
  - auth.member columns from app_notifications.
  - USAGE on the notifications and webhooks schemas from app_api.
- Drops 22 tables, the `billing` schema and `auth.user.phone_number`.

Checks: Squawk is clean (the ignores are listed in docs/testing.md), and
`migrate diff --from-migrations --to-schema` is empty.

## Verification (final tree)

| Check | Result |
|---|---|
| `bun run gen` | exit 0, no diff afterwards |
| `bun run lint` | every step passes |
| `bun run check-types` | exit 0 |
| `bun run test` (turbo `--continue`) | every package passes |
| `bun test ./scripts/ ./.claude/hooks/` | 969 pass, 0 fail |
| `bun run charts:check` | exit 0 |

`test:integration` (turbo `--continue`): every suite passes except 2 tests in apps/ai.

| Suite | Result |
|---|---|
| api | 93 passed |
| web | 307 passed |
| db | 26 passed |
| worker | 23 passed |
| notifications | 11 passed |
| webhooks | 7 passed |
| nest-common | 34 passed |
| jobs | 13 passed |
| ai | 38 passed, 2 failed |

The 2 apps/ai failures:

- `test_models_match_db`:
  - It reflects the shared local `app` database. I did not migrate that database, because other agents' worktrees are using it, so it still has `ai.document` and `ai.chunk`.
  - Against a fresh database migrated from this branch, it passes.
- `test_the_worker_runs_and_stops_cleanly...`:
  - The worker exited with -15 under the parallel turbo load.
  - It passes when run alone (`-k worker_runs`).

## Concerns

1. **Shared local database.** It needs `bun run db:deploy` to apply the migration. Doing that will break any other worktree whose code still reads the dropped tables.
2. **SOPS secrets.** I couldn't edit these. They still hold variables nothing reads any more:
   - `ENCRYPTION_KEYS` (api, webhooks), `UNSUBSCRIBE_SECRET`, `STRIPE_*` and the VAPID keys.
   - The k8s smoke test now generates `STALWART_WEBHOOK_SECRET` for the webhooks Secret.
3. **CI generators job.** `scripts/generators.ts` still smoke-tests the api-feature generator against the todo table, so that job will fail. There is no simple tenant table left: `short_reaction` needs a userId that the template doesn't supply.
4. **Guard-rail-adjacent edits.** I edited `scripts/pre-push.ts` (removed the evals step and its counterparts) and the rule and agent markdown files. I did not touch `.claude/settings.json`, which still allowlists `uv run python -m evals*` and denies `load/.sessions.json`.
5. **Docs drift.** Many docs still describe removed features:
   - docs/architecture.md, auth.md, notifications.md, files-and-billing.md, web-and-mobile.md, python-services.md and new-project.md.
   - Several skills (add-feature, add-notification, rotate-secrets, remove-feature, add-webhook-provider).
   - I updated the env, testing, README, CLAUDE.md and rules files. A docs-sync pass is needed for the rest.
6. **Workspace cap.** `WORKSPACE_MEMBER_LIMIT=1` also caps better-auth's default page size for list-members. The tests that set up a team through the database pass `&limit=100`.
7. **/home is gone.** The Shorts links, the top bar and the bottom nav now point at `/library`. Other agents' branches that link to `/home` will 404 or conflict.
8. **The repo name stays.** `director-editor` is still used where it is the repository's name: compose project, k8s names and the demo password. It never appears as user-facing copy.

## Fix round 1

### Rebase

`git rebase feat/mm/director-hackathon` (base now `8114e5f`). The series is
`377017c..d3e3638`: the original eight commits rebased, then seven for this round.

- Conflicts: `apps/api/src/server.ts` twice (the MCP removal and the API removal),
  `apps/api/src/rpc/procedures.ts`, `apps/api/package.json` and `bun.lock`.
  `.env.example`, `docs/environment.md`, `docs/testing.md`, `apps/api/src/env.ts` and
  `env.test.ts`, `pyproject.toml` and `uv.lock` merged without conflicts.
- The live relay stays mounted:
  - `orgCallerFor(auth, memberships)` is exported, two arguments.
  - `mountDirectorCall` gets `caller: orgCallerFor(auth, memberships)` and
    `caller: deps.caller`, with no API-key wiring.
  - `allowedOrigins` is `[env.WEB_URL]`, since `APP_ORIGINS` is gone.
  - `apiKeyId` was dropped from `apps/api/src/modules/live/live.test.ts`.
- Lockfiles: `bun.lock` is taken from the rebased side and then `bun install` (`bun install
  --frozen-lockfile` shows no changes). `uv lock` resolved with no change, and
  `uv lock --check` passes.
- No `git stash`. My unpushed commits were regrouped with `git reset --mixed` and one
  `--fixup` plus `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash`.

### What changed

| Commit | Change |
|---|---|
| `e963602` style(ai) | `apps/ai/app/seeds/seeds.json` formatted. The integration branch's seed file failed Biome's format check, so `bun run lint` failed, and so did the generators check's lint step. |
| `4e5dbbb` fix(scripts) | Important 1, details below. |
| `fd8e4ab` fix(db) | Minor 1: the migration's header and both suppression reasons now say production holds no data in these tables and old pods may error on them until the rollout finishes. The `docs/testing.md` row says the same (in `d3e3638`). |
| `ed580d8` docs(repo) | Minor 7, details below. |
| `9a91fe4` fix(scripts) | Minor 8, details below. |
| `0abf762` chore(repo) | Minors 3, 4, 6 and the rest of 8, details below. |
| `d3e3638` docs(docs) | Important 3, details below. |

**Important 1 (`4e5dbbb`): the generators check.**
- It copies a throwaway tenant table into its scratch copy before generating:
  - `turbo/generators/smoke/smoke-note.prisma` and `29991231000000_smoke_note/migration.sql`, an `app.smoke_note` table with `org_id`, a foreign key to the organization, forced row-level security and the `tenant_isolation` policy.
  - The check then runs `bun run gen` and generates `smokeNote`.
- `scripts/generators.test.ts` is updated to match.
- The template comments point at `shorts.ts` (contract) and `auth/auth-hooks.ts`' `emitEvent` (service).
- `page` and `PageInput` are restored in `packages/contracts/src/pagination.ts`, tagged `@public` for knip. The generated code imports them, and I had removed them as unused.

**Minor 7 (`ed580d8`): doc-comment examples.** These now use short reactions, `auth.password_changed.v1`, `director.changed`, `/webhooks/stalwart` and `ShortsService`:
- `packages/db/src/tenancy.ts` and `client.ts`;
- `packages/nest-common/src/database.ts`, `outbox.ts`, `logging.ts`, `realtime.ts` and `raw-body.ts`;
- `apps/api/src/outbox.ts` and `http-context.ts`;
- `apps/webhooks/src/inbound/stalwart.routes.ts`;
- `apps/ai/tests/fakes.py`.

**Minor 8 (`9a91fe4`): the fuzzing's sessions file.**
- It moved to `.fuzz/sessions.json`: `scripts/fuzz.ts`, `apps/api/src/load-users.ts`, its seed integration test, `.gitignore` and `.dockerignore`.
- `schemathesis.toml` matched the API by its old title, "Director-editor API". That was a real break from the rename. It now says "Director API", and the removed `ai.ask` exception is gone.

**Minors 3, 4, 6 and the rest of 8 (`0abf762`):**
- Minor 3: `platform.spec.ts` checks every page's title, not only the last one.
- Minor 4: notifications' `WEB_URL` and the ai-worker's `API_URL` are gone from the chart values. Neither had a schema entry or a chart test.
- Minor 6: `common.director` is removed.
- Minor 8: `CODEOWNERS`, `scripts/docker-clean.ts` and its test (the k6 image), and the `release.yml` header.

**Important 3 (`d3e3638`): docs, rules, skills and agents.** Includes all the specific lines the review named.
- Rewritten:
  - `apps/ai/CLAUDE.md`, `apps/api/CLAUDE.md`, `apps/worker/CLAUDE.md`, the root `CLAUDE.md`, `README.md` and `CONTRIBUTING.md`.
  - `deploy/README.md`.
  - `docs/auth.md`, `notifications.md`, `python-services.md`, `jobs-and-events.md`, `database.md`, `architecture.md`, `web-and-mobile.md`, `testing.md` and `new-project.md`.
  - `docs/deploy.md`, `repository-settings.md`, `enhancements.md`, `codegen.md`, `troubleshooting.md` and `director.md` (`/home` is now `/library`).
  - `docs/environment.md` (the `env:set` example and the stack's URL list).
  - `docs/database.md`'s seed paragraph: one demo user.
- Renamed: `docs/files-and-billing.md` became `docs/files.md`, with the billing half removed and links updated.
- Every skill, agent and rule naming removed features is updated, with stale paths fixed. Two skills were rewritten: add-notification and remove-feature.
- A checker found no links or backticked repo paths in these docs that point at missing files.

### Commands and results (final tree)

| Command | Result |
|---|---|
| `bun run gen` | exit 0, no diff |
| `bun run lint` | exit 0, all 20 steps pass |
| `bun run check-types` | exit 0 |
| `bunx turbo run test --continue` | exit 0 |
| `bun test ./scripts/ ./.claude/hooks/` | 974 pass, 0 fail |
| `bun run charts:check` | exit 0 |
| `bun scripts/generators.ts` | exit 0: in a scratch copy, the throwaway table's model and migration, then the database client, an api feature and a package are generated. Lint, types, unit tests and the feature's integration tests all pass. |
| `bunx turbo run test:integration --continue --filter=@repo/api --filter=@repo/db` | exit 0. api 8 files, 96 passed, 13 skipped. db 5 files, 26 passed. |

Unit-test counts: web 165, api 161, client 83, nest-common 79, ai 57, contracts 27,
testing 24, webhooks 24, worker 12, i18n 11, notifications 10, fake-google 10,
ai-client 10, jobs 9, logger 5, email 4.

During the round, `test:integration` caught a test I had broken: the seed test's expected
refusal message (from `9a91fe4`). I fixed it in the same commit through the fixup.

### Concerns

1. **Settings I left alone.** `.claude/settings.json` still allows `uv run python -m evals*`, and its Read deny rule names `./load/.sessions.json`. The new path is `.fuzz/sessions.json`. You said you'll move the rule; I didn't touch settings.json.
2. **Not run, as asked.** I didn't run `bun run db:deploy` on the shared database or `test:e2e`. The new e2e checks (landing page, `/home` gone, titles, the 404s) have never run.
3. **SOPS secrets** still hold variables nothing reads: `ENCRYPTION_KEYS`, `UNSUBSCRIBE_SECRET`, `STRIPE_*`, VAPID, Twilio and the like. Please delete them when you edit the files. The k8s smoke test now gives the webhooks Secret a `STALWART_WEBHOOK_SECRET`.
4. **The render-only lint check** (`scripts/check-web-render-only.ts`) still allows the two `.well-known` route files of the removed mobile app. Tightening it is a lint-rule change, so I left it for you.
5. **Leftover overrides.** `package.json` keeps the `uuid` override and the `decode-uri-component` patch, both pinned for Expo. The dependency-update skill documents them, and `scripts/overrides.test.ts` checks that. Removing them is a dependency change for you to approve.
6. **`orgAdmin`** is still defined but unused, now that there's no workspace admin UI.
