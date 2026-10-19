# fix/mm/hardening

Head: 151aaf8c314c816d6bf3d1954f25a33b5de978f5, rebased onto origin/master 97bb99ba. Ten commits, all pushed.
Every new migration sorts after master's latest one (20261019010000_director_version_ai_read):
020000, 030000, 040000, 050000, 060000.

## 1. BLOCKER: the session pass inserts with ON CONFLICT and no unique index matches (commit 0dd44254, pushed first)
- **Verified:** yes. The only unique indexes were on (session_id, number) and the partial one-open index. A new AI integration test of `DbRecordings.add` as app_ai failed with 42P10 before the fix.
- **Fix:**
  - `20261019020000_recording_attempt_start_unique`: only `CREATE UNIQUE INDEX CONCURRENTLY` on (session_id, part_index, start_ms). It carries a squawk-ignore for require-timeout-settings, listed in docs/testing.md.
  - `@@unique([sessionId, partIndex, startMs])` in app.prisma.
  - Because of the index, a live start at the exact moment another start already sits in that part would now hit a unique violation (500). `mark` now refuses it as `RECORDING_MARK_OUT_OF_ORDER`.
  - drift: clean.
- **Tests:**
  - `apps/ai/tests/test_session_recordings.py`: footage, then add twice plus once more. The rows are numbered, origin pass, queued once.
  - `apps/api/test/recording.integration.test.ts`: a same-moment start is refused.

## 2. HIGH: director.chat outside the AI ledger (34b17a08)
- **Verified:** yes. `live.chat.ts` calls Vertex directly, with no reserve or settle, at 30 a minute and nothing separate for guests.
- **Fix:**
  - The AI service has two new routes, `POST /v1/director/chat-reservations` (reserve `DIRECTOR_TOKENS_PER_CHAT_TURN`, default 20000, through `usage.reserve`, AI_BUDGET_EXCEEDED once the month is spent) and `POST /v1/director/chat-usage` (settle). The new feature is `director-chat`.
  - `DirectorChat.reply` takes a `ChatLedger`. A turn that asks Gemini reserves first and settles in a `finally` with Gemini's `usageMetadata`. An answer that doesn't report its cost keeps the whole reservation.
  - Rate limits: a procedure can now declare several limits (`rateLimitsOf`), and a limit can be `guestsOnly`. Chat gets 10 a minute and 300 an hour; a demo guest gets 6 a minute and 90 an hour on top.
  - The env var is in settings, .env.example and docs/environment.md.
- **Tests:**
  - AI: reserve then settle, refused once the month is spent, the settled amount bounded.
  - API unit (live.chat.test): spend counted per request, an answer with no usage, no ledger for notes.
  - API integration: ledger calls, settled at zero when Gemini fails, AI_BUDGET_EXCEEDED, the 11th turn RATE_LIMITED.
  - Demo guests integration: a guest is RATE_LIMITED on the 7th turn, a member on the 11th.
  - contracts rate-limits test, fake-google usageMetadata test, ai-client test.

## 3. MEDIUM: the shared demo account (d1f617a9)
- **Verified:** yes. Only recording.start was locked, and `purge_demo_footage` covered only the take and cut purposes.
- **Fix:**
  - A new `inPrivateOrg` builder (inOrg plus DEMO_ACCOUNT_LOCKED on the shared account), with router.test BUILDER_CODES updated. It is used for assets.draw, addUpload and addStock, director.brainstorm, create and editPlan, and yourVersion.save and revise. Each declares the error.
  - `20261019030000_shared_demo_purge`: purge_demo_footage now also deletes, for the shared account, once a day old: director-brief-photo and director-asset-image files, director_asset rows of origin created, upload or stock (not default), created plans, and director_version rows. DELETE-only policies `shared_demo_purge` scope the owner to the shared account's rows. docs/director.md is updated.
  - **Not done, and possibly UX-relevant:** Live's `remember` tool on the shared account now fails to save the version. The web shows `DEMO_ACCOUNT_LOCKED` for those writes.
- **Tests:**
  - demo-account integration: 8 procedures answer DEMO_ACCOUNT_LOCKED.
  - worker files integration: the purge deletes what's a day old and keeps defaults, seeds, today's rows and other members' rows.

## 4. MAJOR: the attempt trigger deleted any file, and the API could update any attempt column (d5abf289)
- **Verified:** yes.
- **Fix:** `20261019040000_recording_attempt_file_owner`:
  - The trigger deletes only `director-take-video` files of a member of OLD.org_id. When the workspace itself is being deleted, any such file goes.
  - `REVOKE UPDATE` on app_api, then `GRANT UPDATE (end_ms, status, note, updated_at)`, which is all the API writes.
- **Tests:**
  - API integration: an attempt pointing at another member's take, or at an avatar, deletes neither.
  - app_api can write only those columns.
  - The worker test fixture now adds the member to its workspace, as the app always does. Its AI stand-in had lacked take fields the client already required (reason, chosen, origin), so 6 worker clip tests were failing on master; they pass now.

## 5. MAJOR and LOW: storage that's never deleted (3b311e27)
- **Verified:** yes, for both triggers and the storyboard signing.
- **Fix:** `20261019050000_orphaned_objects`:
  - An AFTER DELETE trigger on ai.director_asset queues object_key and reference_key under `director-assets/`. Every such key embeds the row's own plan id, so no other row shares it. Uploads are left to the files trigger.
  - **Deviation:** the `whole` keys are queued by an AFTER DELETE trigger on app.recording_part, not "before composing". Queuing them before composing would let the hourly files cleanup delete a joined copy while Gemini is still reading it.
  - `storyboardKeyAllowed` in asset-images.ts: `director-assets/<planId>/shot-<16 hex>.(png|jpg)`, used by `withStoryboards`.
- **Tests:**
  - `packages/db/test/storage-queue.test.ts`: the workspace delete queues the 4 director-assets keys and not the upload; a part delete queues `whole`; an existing key isn't queued twice.
  - Unit test of storyboardKeyAllowed, and an API integration test where a foreign key isn't signed.

## 6. Guard rail (fa1d6a40)
- `packages/db/test/migration-policies.test.ts` reads every migration in order and fails when CREATE POLICY reuses a name on the same table. DROP POLICY or ALTER ... RENAME TO frees the name. It needs no database.
- It covers the original collision as a fixture, and passes on today's 41 migrations.

## Extra items from the controller
- **GCS delete 404 (9da23b25):**
  - Verified: GcsStorage.delete rethrew the SDK's 404, and FilesCleanup aborted the batch on it.
  - Fix: a 404 counts as deleted. The cleanup deletes each key on its own, logs `{ key, err }` per failure, keeps that row queued, and pages by keyset so a failed key isn't re-read in the same run.
  - Tests: a storage unit test (404 resolves, 403 throws). A worker integration test queues a gone key, two present ones and a refused one: three rows cleared, the refused one kept and warned once.
- **Aligner (9f44d541):**
  - Verified: ffmpeg ran in the ai pod with the full environment, a probed demuxer and any protocol.
  - Fix: it now runs through app/jail.py, with `-protocol_whitelist https,tls,tcp` (`http,tcp` for http URLs) and any other scheme refused. `-f` is pinned from a new `MatchCutClip.contentType`, which defaults to video/mp4 for an older API. The API sends each take's stored type and refuses a non-video file. ffmpeg is killed on cancellation too.
  - ALIGNER_URL is not required.
  - Tests: the command's shape; real ffmpeg refuses an MP4 read as WebM, an HLS playlist dressed as an MP4, a local path and a `file:` URL; a hung read is killed on cancellation and on timeout; API integration checks the content types sent and refuses a non-video.
- **Session pass lost (d1672700):**
  - Verified: the pass was queued only when finish flipped the status, and the sweeper never queued one.
  - Fix:
    - `20261019060000_recording_session_pass` adds `pass_queued_at`. Existing done sessions are backfilled as queued.
    - It adds `app.session_passes_due(most)` and `app.session_passes_queued(ids)`, granted to app_worker.
    - The API queues whenever the session is done and unqueued, then stamps it. The worker's recording-retention queues every done, unqueued session with the same delay (`SESSION_PASS_DELAY_MS` in contracts) and jobId = session id, then stamps.
  - Tests:
    - API: a pass is queued and stamped, and a lost one is re-queued by a second Done.
    - Worker: the idle-finished session and the lost one are queued with the delay; an already-queued one isn't; a second run queues nothing.
- **UAT1-02, Turnstile CSP (151aaf8c):**
  - Not ours to fix. The console line quotes `connect-src 'self' https://hagen.challenges.cloudflare.com`, which is the policy Cloudflare serves its challenge iframe with, not this page's.
  - Our CSP already allows what Cloudflare documents: script through the nonce and strict-dynamic, frame-src, and connect-src 'self'.
  - I added a proxy.test case that holds it there and keeps `data:` out.
  - Left as is: our connect-src also lists `https://challenges.cloudflare.com`, which Cloudflare's page doesn't list. I didn't remove it without a real-browser check (CI's captcha e2e).

## Checks run (stack 8)
- Passing:
  - `bun run lint` and `bun run check-types`, after the rebase.
  - `bun run gen`: no drift. Prisma drift: clean.
  - Squawk: 0 issues on all 5 new migrations.
  - API: unit 377 passed. Integration 214 passed, 36 skipped (files-tagged). One run timed out in reencrypt (load), and it passes alone.
  - Worker: integration plus files, all passing. ClamAV needed its first signature download.
  - db integration: everything but enums.test.
  - contracts, fake-google, ai-client and nest-common storage unit tests.
  - AI unit: 322 passed. AI integration: 217 passed.
- Failing, but the same on master:
  - 10 AI integration tests in test_create, test_assets storyboards, test_picker, test_service worker and 3 in test_director. I ran master's own tree (b9988e3) against the same database and the same 10 fail, so they don't come from this branch.
  - `packages/db/test/enums.test.ts` (recording and asset-origin CHECK lists vs contracts). This branch adds no CHECKs, and fix/mm/ci-green has a commit for it.
  - API unit `env.test.ts` timed out once under load; nothing here touches env.ts.
- Local setup note: stack 8's `app` database was left with master's failed 20261018200000_demo_guests from a stale shared volume, so I migrated a fresh `app_hardening` database for the AI and drift runs. `bun run db:reset` needs explicit consent, so I didn't run it.
