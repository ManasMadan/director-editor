# Migrations since v1.1.0: review (origin/master @ 943b9dcf)

Scope: 9 migrations, 20261018200000_demo_guests .. 20261018230100_director_take_index.
Applied in production: 200000, 210000 (renamed policies, v1.4.1), 210100, 220000, 220100,
222000, 230000. Pending: 221000_director_take_picks, 230100_director_take_index. There are
no slice 12 migrations on master or on any remote branch.
Paths below are under packages/db/prisma/migrations/ unless they start with apps/.

## Findings, most severe first

[blocker] apps/ai/app/session_recordings.py:312-317 (with 20261018210000_recording:121,124 and 20261018221000_director_take_picks:31)
  Problem: the post-session pass inserts with
  `ON CONFLICT (session_id, part_index, start_ms) DO NOTHING`, but app.recording_attempt
  has no unique index or constraint on (session_id, part_index, start_ms). It has only
  (session_id, number) and the partial one-open index. The only key on those three
  columns is recording_pause's primary key, which is on a different table.
  Impact: every DbRecordings.add raises 42P10 ("there is no unique or exclusion constraint
  matching the ON CONFLICT specification"). The pass that 221000 ships for never adds a
  take, and its job fails and retries. No data is damaged. No test catches it: apps/ai/tests
  never use DbRecordings or touch app.recording_attempt.
  Fix: add a new migration on its own:
  `CREATE UNIQUE INDEX CONCURRENTLY recording_attempt_session_part_start_key ON app.recording_attempt (session_id, part_index, start_ms);`
  Add `@@unique([sessionId, partIndex, startMs], map: ...)` in app.prisma. First check
  production for duplicate rows (two live marks at the same start_ms). A duplicate makes the
  build fail and leaves an INVALID index behind. The index must deploy before or with the code
  that ships the pass. Add an integration test that runs DbRecordings.add as app_ai twice.

[major] Process: these migrations reached master with failing required checks.
  Problem: every PR that added a migration was merged with failing checks. #20, #23, #24, #27,
  #31, #33, #35 and #36 failed "Integration tests" (and most failed "Python service"). #32
  (director_version) failed "Migration safety". Every one had "CI passed" = FAILURE.
  Impact: the integration suite applies every migration, so it would have caught the
  owner_functions collision before it failed in production (#20 shows that failure). The
  Squawk warnings on 222000 (below) and the blocker above went through the same gap.
  Fix: make "CI passed" a required status check in branch protection. Also add a
  migration lint that fails when a new CREATE POLICY name already exists on the same table
  in an earlier migration, unless a DROP POLICY comes first. That catches the collision
  without a database.

[major] 20261018210000_recording:227-237 (delete_recording_attempt_file): SECURITY DEFINER bypasses files.file RLS
  Problem: the trigger deletes `files.file WHERE id = OLD.file_id` as the owner, past the
  own_rows policy. app_api has full UPDATE and DELETE on app.recording_attempt through the
  app schema's default privileges, and the FK checks only that the file exists, not whose
  it is or which workspace it belongs to.
  Impact: a bug in the API that writes file_id, or deletes an attempt pointing at the wrong
  file, deletes another member's file in another workspace. RLS exists to stop exactly
  this. Today only apps/worker writes file_id (clip.processor.ts:322), and the API only
  reads it.
  Fix: add a new migration that CREATE OR REPLACEs the function to delete only
  `purpose = 'director-take-video'` files whose user_id belongs to OLD.org_id (join
  auth.member). Also revoke the API's table-wide UPDATE on app.recording_attempt and grant
  back only the columns it writes. Add a security test for the API role.

[major] 20261018220000_director_assets:11-26: storage objects outlive their rows
  Problem: nothing queues director-assets/<plan>/... objects for deletion: not the default
  images, the drawn or stock ones, or the storyboard cards. ai.director_asset rows go by
  cascade (plan, workspace, demo guest purge). Unlike app.recording_slice
  (queue_recording_slice_deletion) and files.file, they have no AFTER DELETE trigger, and no
  worker task sweeps the prefix.
  Impact: storage grows without bound. A demo guest's generated images, including ones
  drawn from their own reference photo, stay after the 24-hour purge. That contradicts the
  promise in 200000:3-7 that nothing they make outlives the day.
  Fix: add a new migration with a SECURITY DEFINER AFTER DELETE trigger on ai.director_asset
  that inserts OLD.object_key into files.object_deletion when it starts with
  'director-assets/' (uploads are files/<id> and already go with their files.file row). Use
  the same search_path, REVOKE and owner policy rules as the others. Run a one-off sweep for
  objects whose rows are already gone.

[major] 20261018230000_director_created:14-22: rollback past v1.6.0 breaks the library
  Problem: v1.5.0's AI models use `PlanSource = Literal["seed","user"]` and
  `AssetOrigin` without 'storyboard', and DirectorPlanOut/AssetCandidateOut validate
  against them. v1.5.0 contracts use `z.enum(["seed","user"])`.
  Impact: if production rolls back to v1.5.0 after any member has described a template,
  validation fails on the plan list and the asset list for that workspace (500s). The
  migration is expand-only for the schema, but not for the old readers.
  Fix: no change to the applied migration. Record in the rollback runbook that
  v1.6.0 -> v1.5.0 is not safe once a 'created' plan exists (roll forward instead). For later
  value-widening changes, ship the reader that accepts the new value one release before the
  writer. Rolling the pending release back to v1.6.0 is safe: v1.6.0 has no origin,
  reason, chosen_at or take_index in its models and ignores them.

[minor] 20261018221000_director_take_picks: timestamp sorts before migrations already applied
  Problem: 221000 was merged after v1.6.0 had applied 222000 and 230000. Production will
  apply 221000 -> after 230000; a fresh database applies it before 222000. (#32's 222000
  likewise landed after #31's 230000, but both shipped in v1.6.0, so production ran them in
  name order.)
  Impact: none here. 221000 touches only ai.director_take, app.recording_attempt and
  grants, and depends on nothing in 222000 or 230000. prisma migrate deploy applies pending
  migrations whatever their order. The risk is the next one: a fresh database and
  production would replay a real dependency in different orders.
  Fix: make db:lint fail when a new migration's name sorts before master's latest.

[minor] 20261018230000_director_created:17,22 and 20261018150000_director_library:74: constraints left NOT VALID
  Problem: the comment says "a later migration validates them", but none does.
  director_plan_source_check has never been validated, and neither has
  director_asset_origin_check (as re-added here).
  Fix: add a new migration with
  `ALTER TABLE ... VALIDATE CONSTRAINT ...` for both. It takes SHARE UPDATE EXCLUSIVE
  and does not block writes.

[minor] 20261018210000_recording:244-262 (purge_expired_recordings): batching does not shorten the transaction
  Problem: the function says "Batched, so no long lock". It runs as one statement, so every
  LIMIT 500 loop shares one transaction. The leading UPDATE over all expired non-demo
  attempts has no bound at all.
  Impact: a backlog (a missed run, a large demo day) holds row locks on the sessions,
  attempts and slices for the whole purge. It also queues every slice's object in that same
  transaction.
  Fix: add a new migration that CREATE OR REPLACEs the function to do one bounded batch
  per call and return its count. Have the worker loop while a call returns a full batch,
  as with purge_expired_guests.

[minor] 20261018221000_director_take_picks:28-32: app_ai's new grants are wider than the code
  Problem: app_ai may INSERT any status, number or shot into recording_attempt, and it
  reads every column of four recording tables. The code inserts only origin 'pass' with
  status 'clipping', and reads a few columns.
  Impact: a bug in the AI service could insert an 'open' attempt. The one-open index would
  then refuse the member's next live mark.
  Fix: add a new migration with a restrictive policy
  `AS RESTRICTIVE FOR INSERT TO app_ai WITH CHECK (origin = 'pass' AND status = 'clipping')`,
  like api_inserts_seeds_only. Optionally narrow the SELECTs to columns. Grant USAGE on
  app is fine: every app function revokes EXECUTE from PUBLIC (checked: purge_*,
  queue_/delete_recording_*, finish_idle_recordings).

[minor] 20261018221000_director_take_picks:14,22: new origin columns have no CHECK
  Problem: every other text column used as an enum has a CHECK constraint. director_take.origin
  and recording_attempt.origin ('shoot' | 'pass') have none.
  Fix: add CHECK ... NOT VALID now and VALIDATE in a later migration.

[minor] 20261018200000_demo_guests:11,52: no index for the hourly guest purge
  Problem: `guest_until IS NOT NULL AND guest_until <= now() ORDER BY guest_until`
  seq-scans auth.user, which is in the large size class, every hour, and again for each full
  batch.
  Fix: add a new migration with
  `CREATE INDEX CONCURRENTLY user_guest_until_idx ON auth."user"(guest_until) WHERE guest_until IS NOT NULL;`
  on its own.

[minor] 20261018210100_director_take_one_per_file:9: redundant index and an inaccurate comment
  Problem: director_take_file_id_idx (ai.prisma:94) is now redundant with the unique index,
  so every write to a large table maintains two indexes. The comment says the build "takes no
  lock that waits on" anything. In fact CONCURRENTLY waits for every older transaction and
  takes SHARE UPDATE EXCLUSIVE.
  Fix: drop @@index([fileId]) and add `DROP INDEX CONCURRENTLY ai.director_take_file_id_idx` on its own.
  Confirm `indisvalid` for director_take_one_per_file in production.

[minor] 20261018220100_director_asset_picker:18-24: comment overstates what NOT VALID does here
  Problem: VALIDATE runs in the same transaction as ADD ... NOT VALID, so the scan holds the
  ACCESS EXCLUSIVE lock the comment says it avoids.
  Impact: harmless this time. The table was created in 220000, and both shipped in the same
  v1.5.0 deploy while it was empty. Nothing to change in the applied migration.

[minor] 20261018222000_director_version:23-36: Squawk reports 8 warnings with no squawk-ignore
  Problem: Squawk flags non-concurrent indexes, FKs without NOT VALID and checks without
  NOT VALID. All of them are on a table created in the same file, so the exemption the other
  files give in their headers holds. The file just lacks the ignore and its reason.
  Impact: none in production. The warnings went through because #32 merged with "Migration
  safety" failing.

[minor] 20261018200000_demo_guests:135-151 vs 20261018210000_recording:323-324: stale comment
  Problem: demo_guests' owner_functions on files.file was meant to keep the owner to the
  demo account's files. recording_functions_read and recording_functions now give the owner
  SELECT and DELETE on every row. That is harmless, since the owner could disable RLS
  anyway, but the comment no longer holds.

[minor] 20261018220100_director_asset_picker:12-16: director_asset.file_id and base_id have no FK
  Impact: if an upload's files.file row is deleted, its object is queued for deletion and
  the asset row keeps pointing at it. The picker then shows a broken image.
  Fix: an FK (ON DELETE CASCADE for file_id, SET NULL for base_id), added NOT VALID and
  validated in a later migration.

[minor] 20261018222000_director_version: one row per member, but RLS is tenant-only
  The API filters by user_id, and the recording tables do the same. Noted as defence in
  depth only: an own_rows-style policy on app.user_id would hold a member to their own row.

## Checks I made that came back clean

- Timestamps: no two migrations share a name. Every migration on master is the same as in
  the release that applied it, except 210000. That one failed in production before any
  statement committed: Prisma runs a multi-statement file in one implicit transaction. It
  was then changed in place (only the two files.file policy names, owner_functions ->
  recording_functions[_read]). The original could never have succeeded on any database
  that had 200000 (same policy name on files.file), so no environment holds the old
  checksum. A local database with the failed row needs `prisma migrate resolve`.
- Policy names now: files.file has own_rows, ready_avatars, worker_processing,
  owner_functions, recording_functions_read and recording_functions. ai.usage,
  ai.director_plan, ai.director_asset and app.recording_* each have one owner_functions.
  No collisions.
- Fresh database: every migration's dependencies exist by the time it runs (auth.user.demo
  from 183000; director_plan_source_check from 150000; director_asset_origin_check from
  220000/220100; roles from infra/postgres/init). 210100 is alone in its file, as
  CONCURRENTLY requires. Nothing fails.
- Production's current state: 221000 and 230100 add nullable or constant-default columns
  (no rewrite) and grants, with lock_timeout 5s. Both apply cleanly after 230000.
- RLS: every new org_id table (recording_session, recording_part, recording_slice,
  recording_attempt, recording_pause, director_asset, director_asset_choice,
  director_version) has ENABLE and FORCE ROW LEVEL SECURITY and a canonical
  tenant_isolation policy. ai.demo_usage has no org_id, no grants and no RLS. Only the
  definer function writes it.
- SECURITY DEFINER: all 9 new or replaced functions set search_path = pg_catalog,
  pg_temp, use CREATE OR REPLACE, revoke EXECUTE from PUBLIC (re-created ones keep the
  revoke), and grant to one role (the two trigger functions to none). Every forced-RLS table they touch has an owner policy.
- Schema agreement: ai.prisma, app.prisma, auth.prisma and apps/ai/app/db/models.py match
  the SQL by reading. Not run: `drift`, because the main checkout is on an old branch and
  I did not switch it.

## Not run

- `bun run --filter @repo/db drift`: not run. The checkout is on fix/mm/ci-green, not master.
- Integration and security tests: not run. CI shows them failing on every one of these PRs.
- Squawk: run with `bun run db:lint <files>` on master's copies of all 9 migrations. 8
  warnings, all in 20261018222000_director_version. The other 8 files are clean.
