# Task 2.2.2 report: seeds copied at workspace creation

Status: DONE_WITH_CONCERNS (the concerns are pre-existing or come from the environment, not from this change; see the end)

Branch: `worktree-agent-aba34443c1ed512c0`, based on `origin/feat/mm/director-hackathon` (f9fd17d)
Commits: `f9fd17d..d44df31`

- `0bfd737` refactor(contracts): keep Director's seed templates in packages/contracts
- `135cdf3` feat(db): let the api copy seed templates into a workspace
- `d44df31` feat(api): start every workspace with Director's 6 seed templates

(A guard refused the shared-checkout report path, so this report sits at the same relative path inside the worktree. It isn't committed.)

## What changed and why

### 1. Where the seed data lives: `packages/contracts/src/director-seeds.json`

The brief says the api reads templates.json "bundled into the api build", and the api can't import from apps/ai (`no-app-imports-app`). I moved the committed file (`git mv`, contents byte-for-byte unchanged) from `apps/ai/app/seeds/templates.json` to `packages/contracts/src/director-seeds.json`, and added `packages/contracts/src/director-seeds.ts`:

- `directorSeedsSchema`: `z.array(z.strictObject({videoId: videoIdSchema, plan: shotPlanSchema, model, audioKey})).length(6)`
- `directorSeeds`: the file parsed when the module loads (Principle 2). If the file drifts from the contract, the api fails at start-up, before anyone's library can show a bad plan.
- `DIRECTOR_SEED_COUNT = 6`

Why contracts and not a new package, and why not `bun run gen` copying it: contracts already has `shotPlanSchema`, the schema the seeds are validated against, and the add-package skill says to use an existing package that fits. Having gen copy a file out of apps/ai would keep an app-to-app dependency in place, just hidden. The api's tsdown build inlines `@repo/*`, so the JSON ends up in the bundle. I checked: it's in `dist/seeds.repository-*.mjs`. The file also leaves the ai image (`COPY apps/ai/app`), which never read it at runtime.

A unit test (`director-seeds.test.ts`) checks `expect(directorSeeds).toEqual(committed)`. zod drops keys a schema doesn't name, so if the Python `ShotPlan` gains a field the TS `shotPlanSchema` lacks, that field would silently vanish from every workspace's copy. The test fails instead. **Heads-up for the later `seed_media.py` task (plan line 234):** it plans to write `storyboardKey`/`previewKey`/`musicKey` into this file. It needs to write to the new path, and those fields have to go into `shotPlanSchema` (or the seed schema) at the same time, or this test fails.

Python side: `apps/ai/scripts/build_seeds.py` `TEMPLATES_PATH` is now `APP_ROOT.parents[1] / "packages/contracts/src/director-seeds.json"`. I made `_APP_ROOT` public as `APP_ROOT` so the command test's `cwd` no longer depends on where the templates file sits. The tests and docs follow: `apps/ai/CLAUDE.md`, `docs/python-services.md`, `docs/director.md`. `seeds.json` stays in apps/ai: it's the ai script's input only.

### 2. Grants: a narrow expand-only migration, not a call through the ai service

`packages/db/prisma/migrations/20261018170000_director_seed_copies/migration.sql`:

- `GRANT INSERT (org_id, video_id, source, status, stage, plan, model, audio_status, audio_key, created_at, updated_at) ON ai.director_plan TO app_api;`. Excluded on purpose: `created_by`, so a copy can never be in anyone's name, and `error`. `created_at` is included because Prisma sends its own timestamp. I found that by probing: without it the insert gets `permission denied`.
- `CREATE POLICY api_inserts_seeds_only ... AS RESTRICTIVE FOR INSERT TO app_api WITH CHECK (source = 'seed' AND created_by IS NULL)`
- No SELECT, UPDATE or DELETE for the api. The tenant policy still applies.

Why not through the ai service: the copy has to happen in the same transaction as the org creation. An HTTP call to the ai service would be an await inside the transaction (the api rules forbid that), and it would come from another connection that can't see the uncommitted org row its FK points at. Sign-up would also start depending on the ai service being up. The grant is the smaller and cleaner change.

`packages/db/test/security.test.ts` gets a new least-privilege test. The api can copy a seed, a second copy adds 0, and each of these is refused: a `source='user'` insert (RLS), an insert into another workspace (RLS), an insert with `created_by` (permission denied), and SELECT/UPDATE/DELETE on director_plan (permission denied). I renamed the old "Director's cuts and nothing else" test to "read Director's cuts but not change them", since the old name is no longer true.

`packages/db/src/tenancy.ts` gets `enterTenant(tx, orgId)`. It sets `app.org_id` for the rest of a `transaction()`, which the personal-workspace hook needs because the org id only exists once the org is inserted. This reuses the private `setScope` (one implementation). It's tested in security.test.ts and documented in `docs/database.md` and `packages/db/CLAUDE.md`.

### 3. The copy and the hooks

`apps/api/src/modules/director/seeds.repository.ts`. I named it `.repository.ts` instead of the brief's `seeds.ts` because `scripts/check-layers.ts` only lets `*.repository.ts` under `src/modules` touch Prisma.

- `copySeedTemplates(tx: Tx, orgId: OrgId): Promise<number>`: `enterTenant`, then `createMany({ skipDuplicates: true })` with 6 rows: `source='seed'`, `status='ready'`, `stage='ready'`, `plan`, `model`, `audioStatus='ready'`, `audioKey`, and `createdBy` left null. It's idempotent on `(org_id, video_id)`: a Short the workspace already has a plan of (an earlier copy, or a member's own index) keeps that plan. It returns the count (the brief said `void`; the count is what the backfill prints). The rows go in reversed so the library, which is newest-first by uuidv7 id, lists the seeds in seeds.json order. The integration test checks the order.
- The audio URL isn't stored. `DirectorService.toPlan` already turns `audio_key` into a short-lived link through `FilesService.objectUrl` (the storage seam) when the library is read. The integration test checks that each seed's `audio.url` contains `seed-audio/<videoId>.m4a`.

Hooks:

- `apps/api/src/auth/auth-hooks.ts`: the personal workspace (user create `after`) calls `copySeedTemplates(tx, orgId)` inside the existing transaction, before the events.
- `apps/api/src/auth/auth-plugins.ts`: `afterCreateOrganization` (team workspaces) wasn't in the brief. "Every workspace starts with the 6" covers team workspaces too, so I added it. better-auth has already committed the org at that point, so the copy and the `org.created.v1` event now share one transaction instead of going through `record`. If it fails, the backfill picks it up.
- auth imports `../modules/director/seeds.repository` directly. Importing through the director barrel would create a cycle that dependency-cruiser refuses (auth → director → files → files.routes → auth). The barrel rule only restricts imports between modules, and `lint:boundaries` passes.

### 4. The backfill: `bun run --filter @repo/api director:seed-workspaces`

- `apps/api/src/director-seed-workspaces.ts` is a new tsdown entry. It calls `seedWorkspaces(database)`, which pages through `auth.organization` 200 at a time by id and runs one `tenantTx` per workspace, each calling `copySeedTemplates`. It prints `Checked N workspaces: copied T seeded templates into S of them.`
- Production safety: it only inserts seed rows a workspace lacks. It can't touch user plans: the grant has no UPDATE or DELETE, the policy allows seed rows only, and ON CONFLICT DO NOTHING skips a workspace's existing plan of a seed Short. A failure halfway leaves the earlier workspaces done, and a rerun picks up the rest.
- Scripts: `apps/api/package.json` gets `director:seed-workspaces` (`node ... dist/director-seed-workspaces.mjs`, like `seed`/`secrets:reencrypt`, so it runs the built dist). There's also a turbo task (dependsOn build) and a root alias `bun run director:seed-workspaces` that builds first. On production: `node dist/director-seed-workspaces.mjs` in the api image, which is distroless. For example: `kubectl exec deploy/<api> -- /nodejs/bin/node dist/director-seed-workspaces.mjs`. The WORKDIR is `/app/apps/api`.
- `biome.jsonc`: I added the new entry to the existing `noConsole: off` list for the api's commands (seed, load-users, reencrypt). It's the same treatment its siblings get, but it is a lint-config edit, so I'm flagging it.
- I ran it for real against my stack-3 database after `db:deploy`. First run: `Checked 328 workspaces: copied 1968 seeded templates into 328 of them.` Second run: `Checked 328 workspaces: copied 0 seeded templates into 0 of them.`

### 5. Tests

`apps/api/test/director-seeds.integration.test.ts` uses a stand-in AI service whose `/v1/director/library` answers from the database as apps/ai does: as `app_ai`, under RLS, with `ai.index_used`. So the api's real `director.library` procedure returns what the api actually wrote.

- sign-up → library has 6 templates in seed order, each `source seed / status ready / stage ready / error null`, with the committed plan and model, a ready audio link through the storage seam, and `indexUsed=false`.
- A second workspace (a team via `/organization/create`) gets its own 6 rows (12 distinct ids across the two workspaces). Calling `copySeedTemplates` again adds 0, and each workspace has exactly 6 seed rows with `created_by` null.
- A member indexing a seed Short: the statement apps/ai's `_claim` runs, as app_ai (`INSERT ... ON CONFLICT (org_id, video_id) DO NOTHING RETURNING id`), inserts nothing. The seed row is unchanged and `index_used` stays false. Their own index then works once (`index_used` true), and a second own index hits `director_plan_one_user_index`. The real service path for this is already covered by `apps/ai/tests/test_director.py::test_seeded_templates_are_in_the_library_and_count_for_no_one`.
- Backfill: workspaces made without seeds (factories), one of them with a member's own pending plan of a seed Short. The result is `{workspaces: all, seeded: 2, templates: 11}`. The member's plan is untouched (`source user`, `pending`, `created_by` = the member, `index_used` true), and a rerun gives `seeded: 0, templates: 0`. A second test checks paging with page size 2 over 3 workspaces.
- `apps/api/test/seed.integration.test.ts` runs the command entry and checks its output line on the first and second run.

## TDD evidence (the failing run first)

- Contracts, before `director-seeds.ts` existed:
  `FAIL src/director-seeds.test.ts > ... TypeError: Cannot read properties of undefined (reading 'safeParse')`. After writing it: `Test Files 6 passed (6) / Tests 31 passed (31)`.
- db security test with the migration moved aside:
  `Database error. Code: 42501. Message: permission denied for table director_plan` → `Tests 1 failed | 16 passed (17)`. With the migration, the first try still failed the same way (Prisma also sends `created_at`). After adding that column: `Tests 17 passed (17)`, and with the `enterTenant` test, 18 passed.
- api integration, before the repository existed: the import failed. With the repository but before wiring the hooks:
  `× are in a new member's library from sign-up ... expected [] to deeply equal [ '22k0fZarxh8', '152Jy2c3XSM', …(4) ]`
  `× are copied once into each workspace ... expected [] to deeply equal [...]`
  `× leave a member's one index unused ... expected 1 to be +0`
  `× copies the seeds into workspaces missing them ... expected { workspaces: 6, seeded: 6, …} to deeply equal { workspaces: 6, seeded: 2, …}`
  `Tests 4 failed | 1 passed (5)`. After wiring the hooks: `Tests 5 passed (5)`.

## Commands and output tails

Stack: `bun run setup --stack 3` (Postgres on 55732). I stopped it afterwards with `bun run db:down`.

- `bun run lint` → every check ✔ (biome, lint:boundaries, lint:unused, lint:markers, lint:patterns, lint:suppressions, lint:prisma, actionlint, zizmor, shellcheck, hadolint, tflint, renovate, turbo lint incl. ruff/deptry `All checks passed!`)
- `bun run db:lint` → `Found 0 issues in 2 files 🎉`
- `bun run --filter @repo/db drift` → `No drift between migrations, schema and database.`
- `bun run check-types` → `Tasks: 24 successful, 24 total`
- `bun run type-coverage` → every workspace ✔
- `bunx turbo run test --continue` → 21/22 tasks pass: contracts 31, api 188, web 165, nest-common 106, client 83, etc. One failure, **pre-existing and unrelated**: `@repo/testing src/stack.test.ts > moves the apps' own ports ...` expects `GOOGLE_BASE_URL: "http://localhost:12212"`, but `.env.example` now has `GOOGLE_BASE_URL=` empty. I didn't touch packages/testing or .env.example.
- `bun run --filter @repo/db test:integration` → `Test Files 5 passed (5) / Tests 30 passed (30)`
- `bun run --filter @repo/api test:integration` → `Test Files 10 passed (10) / Tests 108 passed | 13 skipped (121)` (the skips are the `files`-tagged suites, excluded by the script)
- `bun run --filter @repo/ai test` → `90 passed, 64 deselected`; `bun run --filter @repo/ai test:integration` → `64 passed, 90 deselected`
- `bun run --filter @repo/ai coverage` → `scripts/build_seeds.py 55 0 4 0 100%`, `TOTAL ... 100%`, `154 passed`. The first run had 1 failure I couldn't reproduce; the next two runs were clean, so I'm treating it as flaky.
- `bun run --filter @repo/api coverage`, `@repo/contracts coverage`, `@repo/db coverage`, then `bun scripts/coverage.ts apps/api packages/contracts packages/db`: the new files (`seeds.repository.ts`, `director-seed-workspaces.ts`, `director-seeds.ts`) and the lines I changed are at 100%. The leftovers it lists come from suites I couldn't run here, not from this change: auth-plugins' invitation and member-limit hooks, account-limits, files/avatar/userTx (the 8 `files`-tagged upload tests need RustFS, which stack 3 doesn't run), errors.ts, procedures.ts.
- `bun test ./scripts/ ./.claude/hooks/` → `971 pass, 2 fail`. Both failures are in `scripts/pre-push.test.ts` and come from my stack's ports: it expects `localhost:55432` and gets `55732`.
- `bun run gen` → `6 cached, 6 total ... FULL TURBO`, no tracked file changed.
- `bun run --filter @repo/api build` → entries include `src/director-seed-workspaces.ts`, `✔ Build complete`. The seed data is bundled.

## Decisions the brief didn't make

1. The seed file lives in `packages/contracts/src/director-seeds.json`, validated by `director-seeds.ts` (reasons in section 1).
2. A narrow column INSERT grant plus a restrictive seed-only policy, instead of going through the ai service (reasons in section 2).
3. `seeds.repository.ts` instead of `seeds.ts` (layering check). `copySeedTemplates` returns the count.
4. Team workspaces (`afterCreateOrganization`) get seeds too, in a transaction with their audit event.
5. The new `enterTenant` helper in packages/db.
6. Seeds are inserted in reverse, so the library lists them in seeds.json order.
7. A root alias and turbo task for the backfill, plus the `biome.jsonc` noConsole list entry for the new command.

## Concerns

- `biome.jsonc` is lint config: I added one path to the existing per-command `noConsole: off` list. If you'd rather not, the command could print through `process.stdout.write`.
- Pre-existing failures I didn't fix: `packages/testing/src/stack.test.ts` (GOOGLE_BASE_URL) and `scripts/pre-push.test.ts` (fails when run on a non-default stack).
- On deploy, the migration has to run before the new api starts. Signing up on the old release after the migration is harmless: the grant just goes unused.
- At ship time the controller should run the backfill once on production (`node dist/director-seed-workspaces.mjs` in the api pod). It's safe to run again.
- The later `seed_media.py` task must write to the new path, and must extend the contract schema for any new fields (the contracts test will fail until it does).
