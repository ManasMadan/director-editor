# Task 2.2.1 + 2.2.3 report: Director's data model and API

Status: DONE_WITH_CONCERNS (concerns at the end; none blocks merging)

(Written inside the worktree: the guard refused the shared-checkout report path. Untracked, not committed.)

Worktree: `.claude/worktrees/agent-a1508f578ca37e552`, branch `worktree-agent-a1508f578ca37e552`,
reset onto `origin/feat/mm/director-hackathon` (1ea8e58) first.

Commits (range `1ea8e58..4344558`):

- `3f532d8 feat(db): add the director library columns, cuts and one short per member`
- `4344558 feat(api)!: index shorts into a library, with shots and cuts`

## What changed and why

### 2.2.1 Schema and migration (`20261018150000_director_library`)

- `ai.director_plan`: `source text not null default 'user'`, `stage text not null default 'queued'`,
  `audio_status text not null default 'none'`, `audio_key text null`. CHECKs on the three enum-like
  columns, added `NOT VALID` (the table has rows; every existing row holds the passing default; a
  later migration can `VALIDATE`).
- `ai.director_cut` as briefed (uuidv7 id, org_id, plan_id, user_id, title, picks jsonb,
  file_id → files.file, duration_ms, publish_status default 'none', youtube_video_id, visibility,
  created_at, updated_at). FKs cascade (org, plan, user, file); indexes `(org_id, id desc)`,
  `(plan_id, user_id)`, `(user_id)`, `(file_id)`; CHECKs (publish_status, visibility in
  private/unlisted/public, YouTube id pattern, duration ≥ 0, picks is a JSON array). `ENABLE` +
  `FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy copied from init. Grants: `app_ai`
  SELECT/INSERT/UPDATE; `app_api` gets `USAGE ON SCHEMA ai` and SELECT on `director_cut` only.
- The partial unique index, verbatim: `director_plan_one_user_index on ai.director_plan (created_by)
  where source = 'user' and status <> 'failed'`. It's modelled in Prisma with the existing
  `partialIndexes` preview (`@@unique(..., where: raw(...))`), so drift is clean, and in
  `apps/ai/app/db/models.py` (`postgresql_where`).
- Backfills (my call, see Decisions). First, `stage = status` for ready and failed plans. Second, the
  old flow created a plan in your name for every short you opened, so a member can have several
  non-failed plans and the unique index couldn't build. Each member keeps their newest; the older
  ones get `created_by = NULL` and stay in the library. Forced RLS applies to the table owner too,
  so these UPDATEs would silently match nothing; the migration lifts `FORCE` for the two updates
  only and puts it back in the same transaction.
- Zero-downtime reasoning: the new columns have constant defaults, so nothing is rewritten. The
  ALTER takes director_plan's ACCESS EXCLUSIVE lock and holds it until commit, so the dedupe update
  and the (non-concurrent) unique index build see the same table and no write can slip in between.
  The table is small (library rows), and the wait is bounded by `lock_timeout = '5s'`. The previous
  release keeps working: it ignores the new columns. The only thing it loses is making a second
  plan in one member's name, which is the limit we want.
- I tested it on a database seeded with legacy-shaped rows before migrating: one member with 3
  non-failed plans and 1 failed, another with 1 pending, and one plan with no creator. After
  `db:deploy`: the newest non-failed plan keeps its creator, the older ones belong to nobody, the
  failed one keeps its creator, stages read ready/failed/queued as they should, and
  `relforcerowsecurity` is still true on both tables.
- Squawk is clean (`bun run db:lint`: 0 issues). The `squawk-ignore`s are per statement with
  reasons, plus the row docs/testing.md's Suppressions table requires (`lint:suppressions` passes).
- `packages/db/test/security.test.ts`: app_api may SELECT director_cut, may not UPDATE it, and may
  not read director_plan. `packages/db/test/enums.test.ts` ties the five new CHECKs to the
  contracts' enums. The existing all-tables test covers forced RLS on director_cut.

### 2.2.3 Contracts, errors, procedures

`packages/contracts/src/api/director.ts`:

- `directorPlanSchema` gains `source: "seed"|"user"`, `stage: "queued"|"watching"|"writing"|"ready"|"failed"`
  and `audio: {status: "ready"|"failed"|"none", url: url|null}`.
- `director.library` GET `/director/library` → `{templates: DirectorPlan[], indexUsed: boolean}`, newest first.
- `director.index` POST `/director/library` `{url}` (trimmed, 1..`SHORT_URL_MAX_LENGTH`) → `DirectorPlan`.
  Rate limit `director-index`, 10 per hour per user. Replaces `requestPlan`, which is removed.
- `director.shots` GET `/director/{videoId}/shots` → `[{index, takes, pickedTakeId, needsRetake}]`.
- `director.cuts` GET `/director/{videoId}/cuts`. `director.saveCut` POST `/director/{videoId}/cuts`
  `{picks: Record<number, DirectorTakeId>, fileId, title}`: picks non-empty, title trimmed and at
  most 100 characters, `EVERYDAY_WRITES`. `director.media` GET `/media` → `DirectorCut[]`.
- `DirectorCut {id, planId, videoId, templateTitle, title, picks, fileId, durationMs, createdAt,
  publish: {status, youtubeVideoId, visibility}}`.
- `DIRECTOR_RETAKE_BELOW = 60` is exported. New id `directorCutIdSchema`. New upload purpose
  `director-cut-video` (mp4/webm, 200 MB); the worker keeps it as rendered.
- Error codes, following the add-error-code steps with en messages: `DIRECTOR_INDEX_LIMIT` 409,
  `DIRECTOR_VIDEO_UNAVAILABLE` 422, `DIRECTOR_TOO_LONG` 422 (`maxSeconds`). `SHORT_TOO_LONG` is
  removed because nothing throws it any more; `DIRECTOR_TOO_LONG` replaces it.
  `DIRECTOR_PLAN_NOT_FOUND`'s message now reads "This Short isn't in your library yet."

Where each part runs:

- apps/api, `ShortsService.filmable(link)`: parses the link with `videoIdFromLink` (watch, shorts,
  youtu.be, bare id) and checks YouTube. It throws `DIRECTOR_VIDEO_UNAVAILABLE` (not a YouTube link,
  or YouTube won't show it) or `DIRECTOR_TOO_LONG` before the AI service is called.
- apps/ai, `Director.index` (route `POST /v1/director/plans`, operationId `indexDirectorPlan`):
  - An existing non-failed plan for the video is returned and counts for no one, seeds included.
  - A new plan, or a retried failed one, is claimed in the caller's name, but only after checking
    they have no non-failed `source='user'` plan (otherwise `DIRECTOR_INDEX_LIMIT`).
  - When two requests race, the insert hits the unique index. An `IntegrityError` whose psycopg
    `diag.constraint_name` is `director_plan_one_user_index` maps to `DIRECTOR_INDEX_LIMIT`; any
    other integrity error is re-raised.
  - It writes `stage='queued'` on create and retry, and `ready` or `failed` wherever it already set
    status (`analyze`, `_fail_plan`). The finer stages are 2.1.3's.
- apps/ai, `library`, `save_cut` and `cuts` (routes `GET /v1/director/library`,
  `POST /v1/director/cuts`, `GET /v1/director/plans/{id}/cuts`, `GET /v1/director/cuts`):
  - A cut needs a ready plan (`DIRECTOR_PLAN_NOT_READY`).
  - Its picks must be the caller's takes of that plan and shot: `DIRECTOR_SHOT_NOT_FOUND`,
    `NOT_FOUND`, and `VALIDATION_FAILED` for duplicates.
  - `duration_ms` is worked out on the server: a reviewed video take's best part, otherwise the
    shot's `durationSeconds`.
- apps/api, `DirectorService`:
  - `shots` takes the plan and the takes from the AI service and groups them with the pure
    `shotsOf` (`shots.ts`).
  - `saveCut` checks the file with `FilesService.ready(..., "director-cut-video")`. Another
    member's file is invisible under RLS (`FILE_NOT_FOUND`); an unchecked one is `FILE_NOT_READY`.
  - A plan's `audio.url` is `FilesService.objectUrl(audioKey, 1 hour)` when
    `audio_status = 'ready'`, and `null` while uploads (storage) are off.
  - `PASSED_ON` gains `DIRECTOR_INDEX_LIMIT` and `NOT_FOUND`.
- packages/ai-client: `index`, `library`, `createCut`, `listCuts`, `listMedia`; `requestPlan` is gone.
- packages/client: `request-plan.ts` is replaced by `index-short.ts` (`useIndexShortMutation`).
- apps/web: the template page no longer requests a plan by itself. A missing plan shows "This Short
  isn't in your library yet." with the existing "Try again" button, which calls `director.index`.
  No new UI.

## Commands and output tails

TDD evidence (failing first):

```
$ uv run pytest -m integration tests/test_director.py -q -k "index or library or seeded or cut"   (before director.py/main.py changes)
FAILED tests/test_director.py::test_indexing_a_short_queues_its_analysis_once
FAILED tests/test_director.py::test_a_member_indexes_one_short_of_their_own
FAILED tests/test_director.py::test_a_failed_index_doesn_t_count - pydantic_c...
FAILED tests/test_director.py::test_two_index_requests_at_once_count_once - A...
FAILED tests/test_director.py::test_an_index_racing_another_is_refused_by_the_database
FAILED tests/test_director.py::test_seeded_templates_are_in_the_library_and_count_for_no_one
FAILED tests/test_director.py::test_a_cut_keeps_its_picks_and_how_long_they_last
FAILED tests/test_director.py::test_a_cut_s_picks_are_the_member_s_takes_of_those_shots
10 failed, 30 deselected, 1 warning in 16.48s

$ bun run --filter @repo/api test -- src/modules/director/shots.test.ts   (before shots.ts existed)
@repo/api test:  Test Files  1 failed (1)
```

Checks on the final tree:

```
$ bun run lint            every step ✔ after fixes (knip and lint:suppressions re-run with no
                          findings); biome: 1 warning, already there (scripts/image-scan.test.ts:279)
$ bun run check-types     Tasks: 24 successful, 24 total
$ bun run test            Tasks: 22 successful, 22 total
$ bun run test:integration
  @repo/db       Tests 27 passed (27)
  @repo/api      Tests 102 passed | 13 skipped (115)
  @repo/ai       53 passed, 71 deselected
  @repo/worker   Tests 23 passed | 17 skipped (40)
  @repo/web      Tests 307 passed | 16 skipped (323)
  Tasks: 15 successful, 15 total
$ bun run test:integration:files   (after ClamAV finished loading its signatures)
  @repo/worker   Tests 17 passed | 23 skipped (40)   ← includes the new director-cut-video case
  @repo/api      Tests 13 passed | 102 skipped (115)
  @repo/web      1 failed: test/settings/avatar.test.tsx "says so when storage refuses the upload"
                 (hard-codes ":59000/"; my stack runs RustFS on 59300; unrelated to this change)
$ bun run --filter @repo/ai coverage   124 passed; app/director.py, main.py, schemas.py, db/models.py at 100%
$ bun run --filter @repo/api --filter @repo/ai-client --filter @repo/client --filter @repo/contracts --filter @repo/worker coverage   all exited 0
$ bun scripts/coverage.ts <touched paths>
  ✖ apps/ai/app/telemetry.py: lines 44, 45 ...   (untouched; needs the full merged run)
  ✖ packages/contracts/src/pagination.ts: line 20 (untouched)
  every file I touched is at 100%
$ bun run --filter @repo/db drift      No drift between migrations, schema and database.
$ bun run db:lint                       Found 0 issues in 1 file
$ uv run pytest -m integration tests/test_models_match_db.py   1 passed
$ bun run gen                           no drift afterwards (git status clean)
$ bun test ./scripts/ ./.claude/hooks/  970 pass, 2 fail: scripts/pre-push.test.ts "the database
                          steps" expect port 55432 and get 55732. My worktree runs on its own
                          stack (.env.stack), so this is the environment, not the code.
$ bun run type-coverage   fails only on packages/i18n/src/index.ts:51 "Unused ignore line
                          directive"; it fails the same way with the original en.json, so it
                          was already there
```

Tests added or changed:

- apps/ai/tests/test_director.py:
  - `test_a_member_indexes_one_short_of_their_own`: a second index is DIRECTOR_INDEX_LIMIT; the
    same short again is the same plan.
  - `test_a_failed_index_doesn_t_count`.
  - `test_two_index_requests_at_once_count_once` **[RF 3]**: with asyncio.gather, the same short
    twice is one plan, and two different shorts are one plan and one DIRECTOR_INDEX_LIMIT.
  - `test_an_index_racing_another_is_refused_by_the_database` **[RF 3]**: deterministic. Another
    transaction holds an uncommitted plan; the test waits in pg_locks until the service's insert
    blocks, then commits, which drives the unique-violation path to DIRECTOR_INDEX_LIMIT.
  - `test_seeded_templates_are_in_the_library_and_count_for_no_one`: seed rows inserted directly,
    including one whose `created_by` is the member.
  - `test_an_index_the_database_refuses_otherwise_is_not_the_limit`.
  - `test_a_cut_keeps_its_picks_and_how_long_they_last` and
    `test_a_cut_s_picks_are_the_member_s_takes_of_those_shots`.
  - Stage assertions added to existing tests.
- apps/api:
  - `shots.test.ts`: picks the highest score, ties go to the newest, a retake below 60 but not at
    60, no score means no pick.
  - `director.integration.test.ts`: index from every kind of link; DIRECTOR_TOO_LONG with
    maxSeconds; DIRECTOR_VIDEO_UNAVAILABLE for a gone video and for a non-YouTube link, both before
    the AI service is called; DIRECTOR_INDEX_LIMIT passed through; the library with a signed audio
    link, and tenancy; shots picks the highest score and flags needsRetake below 60; saveCut
    rejects another user's file, a take's file, an unready file, empty picks and a long title;
    cuts and media list.
  - `director-without-storage.integration.test.ts`: audio ready with uploads off gives `url: null`
    (Valkey db 25).
- packages/db security and enum tests, ai-client, client, worker (the cut purpose), and the web
  template page tests.

## Decisions the brief didn't make

1. One migration, not a separate CONCURRENTLY one for the unique index. The dedupe update and the
   build have to be atomic, the ALTER's lock already blocks writes, and the table is small. This is
   written up in the migration and in docs/testing.md.
2. Legacy duplicates stay in the library with `created_by = NULL`, and each member keeps their
   newest. Without this, the index would fail on production data from the old
   open-a-short-make-a-plan flow.
3. `index` takes only `url`. A link that can't be parsed is `DIRECTOR_VIDEO_UNAVAILABLE`, not a
   fourth code.
4. A failed plan that a member retries becomes that member's index (`created_by` moves to them).
5. Bad cut picks: `DIRECTOR_SHOT_NOT_FOUND` for a shot the plan doesn't have, the generic
   `NOT_FOUND` for a take that isn't the caller's take of that shot, and `VALIDATION_FAILED` for
   duplicates. Picks may cover only some of the shots, but at least one.
6. `durationMs` is worked out on the server from the picks, because the input has no duration: a
   reviewed video take's best part, otherwise the shot's length.
7. `publish.visibility` is `"private"|"unlisted"|"public"|null` rather than a free string. The
   database CHECKs it, and `packages/db/test/enums.test.ts` requires the contract to name the same
   values. It's still assignable to `string | null`.
8. `audio.url` is a presigned read (1 hour) of `audio_key` through the API's existing storage seam
   (`FilesService.objectUrl`), and null while storage is off. Once 2.2.4's GCS storage lands, it
   signs the same keys the AI service writes (one bucket, per the ledger's ruling).
9. `needsRetake` is false for a shot with no scored take: nothing is picked yet, and the shot is
   still waiting for its first take or its review.
10. Library, media and cuts return plain arrays, as the brief's contract says (like `takes`), not pages.
11. I added only the index hook to packages/client. knip (`includeEntryExports` over the `./api/*`
    export) refuses hooks nothing imports, so the library, shots, cuts and media hooks should land
    with their pages in 2.3. For the same reason `directorLibrarySchema`, `directorShotSchema` and
    `DIRECTOR_CUT_TITLE_MAX_LENGTH` aren't exported yet; their types are.
12. Every service in this worktree ran on its own compose stack (`bun run setup --env --stack 3`,
    Postgres on 55732), so the migration never touched the owner's dev database or other agents'
    worktrees. The worktree's `.env` and `.env.stack` point at stack 3. I stopped its containers at
    the end with `bun run db:down`; `bun run db:up` brings them back.

## Concerns

- Breaking change to `/api/v1`: `director.requestPlan` is removed and `SHORT_TOO_LONG` is gone. The
  commit is marked `!`, and the PR title needs `!` for the api-compat job.
- `indexUsed` and the pre-insert check only see the caller's current workspace (RLS). The unique
  index is global, so a member's second short in another workspace is still refused (as
  DIRECTOR_INDEX_LIMIT), but `indexUsed` reads false in that other workspace until they try.
- During the rollout, a plan the old worker finishes keeps `stage='queued'` with `status='ready'`,
  because the old code doesn't write stage. It's harmless once the new worker is up; 2.1.3 may want
  to treat `status` as the authority for finished plans.
- `director-cut-video` allows 200 MB, but the worker reads the whole file into memory, and clamd's
  default `StreamMaxLength` is 100 MB with a 30 s scan timeout. A cut over about 100 MB would fail
  the scan. Before 2.3/2.4 upload real cuts, either set `CLAMD_CONF_StreamMaxLength` (compose and
  the chart) or lower the cap.
- `app_api` has SELECT on `director_cut` as briefed, but nothing in the API reads it yet.
  Publishing in 2.4 will also need to update the publish fields, which today only `app_ai` may.
- `test/settings/avatar.test.tsx` hard-codes RustFS's default port, and `scripts/pre-push.test.ts`
  assumes the default Postgres port, so both fail on any `--stack`. Neither is new; they fail here
  only because of my stack.

## Fix round 1

Review 1 (`task-2.2-core-review-1.md`), items 1–6. Commits (range `4344558..829ee55`):

- `c71bead fix(db): start every member with their index unused, counted across workspaces`
- `829ee55 fix(api): take index requests in turn and name a take that isn't yours`

The migration isn't shipped, so I edited it in place. Everything still ran on stack 3; I recreated
stack 3's own `app` database to re-apply the edited migration. The owner's dev database was never
touched.

**Correction to the first report:** I said "Squawk is clean". That was wrong. `bun run db:lint`
diffs `master...HEAD`, so it only reads committed migrations; while mine was uncommitted it was
never linted. The "0 issues" came from the other migration on the branch. Linted for real, the
multi-clause `ALTER TABLE ai.director_cut ... ADD CONSTRAINT ×5` drew 5 `constraint-missing-not-valid`
warnings, because one ignore comment covers only one statement's first line. Each check is now its
own statement with its own ignore. The committed migration is now clean:
`bun run db:lint` → `Found 0 issues in 2 files`.

| # | Ruling | Change | Pinned by |
|---|---|---|---|
| 1 | Cut cap 200 → 100 MB, comment | `packages/contracts/src/files.ts:33-42` (cap 100_000_000; comment: ~720x1280 at ~4 Mbit/s fits 3 minutes; the worker buffers and ClamAV's default stream limit is 100 MB) | `apps/api/test/director.integration.test.ts:906-916`: a 100_000_001-byte cut upload is `FILE_TOO_LARGE` with `maxBytes: 100000000` (failed with the cap at 200 MB: "expected FILE_TOO_LARGE: expected undefined to be an instance of ORPCError") |
| 2 | De-attribute every legacy user plan | `migration.sql:90-95`: `UPDATE ai.director_plan SET created_by = NULL WHERE source = 'user' AND created_by IS NOT NULL`, in place of the correlated dedupe; stage update, FORCE handling and the index in the same transaction kept (`:85-102`) | Legacy-shaped check, re-run on a scratch database (`legacycheck` on stack 3, migrated to the previous migration, legacy rows inserted, then this migration applied): every plan has `created_by` NULL, stages ready/failed/queued/ready/queued/ready as expected, `relforcerowsecurity` true on both tables, `ai.index_used(member A) = f`. Output below. |
| 3 | Serialise each member's index requests | `apps/ai/app/director.py:296-305` `_take_turns`: `pg_advisory_xact_lock(hashtextextended(<user id>, 0))`, called first in `_claim` (`:480`); IntegrityError → DIRECTOR_INDEX_LIMIT backstop kept | `tests/test_director.py:722` `test_a_member_s_index_requests_take_turns` (deterministic: the test holds the member's lock and inserts their plan; the service must wait on an **advisory** lock, then answers with that same plan, not a refusal; failed before the fix with "the index never waited on the other plan"). `:694` `test_two_index_requests_at_once_count_once` is now deterministic because requests take turns. `:753` the racing test still drives the backstop (it waits on a `transactionid` lock). |
| 4 | `ai.index_used` SECURITY DEFINER | `migration.sql:104-125`: `ai.index_used(user_id uuid) returns boolean`, `STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp`, `REVOKE ... FROM PUBLIC`, `GRANT EXECUTE ... TO app_ai`, plus a read-only `owner_functions` policy `FOR SELECT TO migrator` on director_plan (the db rules' pattern; the security test's owner-functions check passes). `director.py:288-293` `_index_used` calls it (`type_coerce(func.ai.index_used(...), Boolean)`) | `tests/test_director.py:743` `test_an_index_counts_in_every_workspace` (indexUsed true in workspace B after indexing in A; failed before with `indexUsed=False`); `packages/db/test/security.test.ts:198` (app_ai may call it, app_api may not) |
| 5 | Say the previous release's request_plan 500s | `migration.sql:10-15` (rollout comment); this report, Concerns, below | n/a (documentation) |
| 6 | Specific code, not generic NOT_FOUND | `packages/contracts/src/errors.ts:74-75` `DIRECTOR_TAKE_NOT_FOUND: 404`; `packages/i18n/messages/en.json:296`; `packages/contracts/src/api/director.ts:35,330`; `apps/ai/app/director.py:282`; `apps/api/src/modules/ai/ai.service.ts:17-28` (NOT_FOUND removed, DIRECTOR_TAKE_NOT_FOUND added) | `tests/test_director.py:897` (picks expect DIRECTOR_TAKE_NOT_FOUND; failed before with "assert 'NOT_FOUND' == 'DIRECTOR_TAKE_NOT_FOUND'"); `apps/api/test/director.integration.test.ts:875-878` (passed on by the API; failed without it in PASSED_ON: "expected 'UPSTREAM_UNAVAILABLE' to be 'DIRECTOR_TAKE_NOT_FOUND'") |

Two details beyond the rulings:

- The advisory lock key is the user id string bound as a parameter. A SQL `cast(...)` trips
  `lint:suppressions`, which reads `cast(` as `typing.cast`.
- The `owner_functions` policy is `FOR SELECT` only. ai.index_used just reads, and the backfill
  updates keep the FORCE toggle as ruled.

### TDD evidence (failing first)

```
$ uv run pytest -m integration tests/test_director.py -q -k "take_turns or every_workspace or picks_are"   (before the fixes)
E       AssertionError: the index never waited on the other plan
E       AssertionError: assert False is True
E        +  where False = DirectorLibraryOut(templates=[], indexUsed=False).indexUsed
E           assert 'NOT_FOUND' == 'DIRECTOR_TAKE_NOT_FOUND'
$ bun run --filter @repo/api test:integration -- test/director.integration.test.ts -t "saves a cut"   (DIRECTOR_TAKE_NOT_FOUND not in PASSED_ON)
AssertionError: expected 'UPSTREAM_UNAVAILABLE' to be 'DIRECTOR_TAKE_NOT_FOUND' // Object.is equality
      Tests  1 failed | 21 skipped (22)
$ bun run --filter @repo/api test:integration -- test/director.integration.test.ts -t "refuses a cut"   (cap at 200 MB)
AssertionError: expected FILE_TOO_LARGE: expected undefined to be an instance of ORPCError
      Tests  1 failed | 21 skipped (22)
```

### Legacy-shaped data, re-run (item 2)

```
  video_id   | created_by |  status   | stage  | source
-------------+------------+-----------+--------+--------
 aaaaaaaaaa1 |            | ready     | ready  | user
 aaaaaaaaaa2 |            | failed    | failed | user
 aaaaaaaaaa3 |            | analyzing | queued | user
 aaaaaaaaaa4 |            | ready     | ready  | user
 bbbbbbbbbb1 |            | pending   | queued | user
 nnnnnnnnnn1 |            | ready     | ready  | user
    relname    | relforcerowsecurity
 director_plan | t
 director_cut  | t
 index_used = f
```

(This ran before I split the cut checks into one statement each. That change touches only the
`director_cut` CHECK statements, not the backfill or the plan table.)

### Checks

```
$ bun run lint            no ✖ (biome: 1 warning, already there in scripts/image-scan.test.ts)
$ bun run check-types     Tasks: 24 successful, 24 total
$ bun run test            Tasks: 22 successful, 22 total
$ bun run test:integration
  @repo/db   Tests 28 passed (28)
  @repo/api  Tests 102 passed | 13 skipped (115)
  @repo/ai   55 passed, 71 deselected   (includes test_models_match_db)
  @repo/web  Tests 307 passed | 16 skipped (323)
  Tasks: 15 successful, 15 total
$ bun run --filter @repo/ai coverage   126 passed; director.py, main.py, schemas.py, db/models.py at 100%
$ bun run --filter @repo/api coverage  Tests 281 passed (281)   (needs the files profile: bun scripts/services.ts up --files)
$ bun run --filter @repo/contracts|ai-client|client|worker coverage   all passed
$ bun scripts/coverage.ts <touched paths>
  ✖ apps/ai/app/telemetry.py, ✖ packages/contracts/src/pagination.ts   (both untouched, as before)
$ bun run db:lint          Found 0 issues in 2 files
$ bun run --filter @repo/db drift   No drift between migrations, schema and database.
$ bun run gen              no drift (tree clean after it)
```

### Concerns (round 1)

- Rollout (item 5): while the previous release is still serving, its `request_plan` answers 500
  (an unhandled IntegrityError) to a member who already has a non-failed plan of their own. The
  window is short and the release is marked `!`. Right after the migration, every legacy plan
  belongs to nobody, so in practice it only hits a member who indexes twice inside that window.
- Item 7 (the template page's "Try again" spends the index) is left for 2.3.5, as ruled.
- Still open from round 0: `app_api` reads `director_cut` but can't update the publish fields (2.4).
