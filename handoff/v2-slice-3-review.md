# Slice 3 (continuous recording, server side): engineering review

Branch `origin/feat/mm/v2-recording` at `7dff873`, six commits on `ae43b93` (merge base with
master). I reviewed the diff with `git diff ae43b93..origin/feat/mm/v2-recording`, the spec
(6.3, 6.4, 6.11, 6.14, 12 slice 3, 14 privacy, 18) and the implementer's report. Line
numbers are on the branch tip. I ran nothing against the code: checking out the branch
would have changed a checkout. Findings come from reading the code and from
`git merge-tree`.

## Verdict per check

| # | Check | Verdict |
|---|---|---|
| 1 | Security | **Fail.** Presigning and authorization are sound. Untrusted footage goes through an ffmpeg that isn't hardened, and by default in production that ffmpeg runs inside the ai pod, which holds the secrets (C1). On a shared demo account, demo guests see each other's sessions (I7). |
| 2 | Correctness | **Partial.** The mark math, pauses as walls and the 60 s cap are right. A retried end mark can destroy the next attempt (I6). A Done/mark race strands an open attempt (M1). |
| 3 | Retention and cleanup | **Partial.** The 7/14/24 h rules, `keep`, the deletion trigger and the 6 h finish are right. Attempts in done sessions can wait forever (I2). Delete can race the clipper and leave a take behind (I3). Jobs queued by the maintenance task lose the queue's retry options (I1). |
| 4 | Limits | **Partial.** The limits are not atomic, and the 20 minutes is counted from the duration the client declares (I4). |
| 5 | Migrations | **Pass.** Expand-only. The Squawk ignore is documented in docs/testing.md. RLS is forced on all five tables. The trigger and the definer functions are sound. Minor notes in M8. |
| 6 | Client helper | **Pass with minors.** Order, backoff, permanent drops and the resume after a dead tab are correct. The queue has no 5-minute cap, can block at its head, and reads the whole store on every loop (M5). |
| 7 | Infra and docs | **Partial.** The chart, network policy, KEDA and the CI ffmpeg install are right. In-process clipping isn't sized for the 768 Mi ai pod (I5). The docs say 512 MiB and call the in-process clipper sandboxed (M2). The lifecycle rule is documented but not applied. |
| 8 | Tests | **Partial.** The tests are real (real Postgres, RustFS, ffmpeg). Several things are untested: jobs queued by maintenance, the races, recordings shaped like MediaRecorder's, and the take-signature check the worker test dropped (M3). I couldn't verify the 100% coverage claim without the full profile. |
| 9 | Merge conflicts | origin/master 581ab3a: **clean**. origin/feat/mm/director-v2 31e7c08: **1 conflict** (`docs/environment.md`). origin/feat/mm/v2-assets 7b0d732: **5 conflicts**: `apps/ai/app/main.py`, `apps/ai/openapi.json`, `docs/testing.md`, `packages/ai-client/src/generated/index.ts`, `packages/db/prisma/schema/ai.prisma`. Regenerate the two generated files; don't hand-merge them. The ai.prisma conflict comes from `prisma format` realigning DirectorPlan/DirectorTake columns. |
| 10 | Commit messages | **Pass.** All six are Conventional with a scope. None mentions AI tooling or has a co-author trailer. Minor hygiene in M9. |

## Critical

### C1. ffmpeg decodes member-supplied bytes with no format pin, no protocol whitelist, the full environment and no limits, inside the ai pod by default

- **Where:** `apps/ai/app/clipping.py:147-164` (`speech_args`), `:167-210` (`cut_args`); `apps/ai/app/process.py:15-17`; `apps/ai/app/main.py:92-94` (`LocalClipper` whenever `CLIPPER_URL` is unset); `deploy/environments/production/stack.yaml:66-69` (production clips in-process "until the Cloud Run clipper is deployed"); `apps/api/src/modules/recording/recording.service.ts:9-11` and `docs/files.md` (both say only the sandboxed clipper decodes slices).
- **What:**
  - The presigned PUT pins the Content-Type header and the length, not the bytes. Any member, demo visitors included, can store any file as a slice.
  - The clipper writes the joined slices to a file named `footage` with no extension and runs `ffmpeg -ss … -i footage`. Nothing forces the demuxer, so ffmpeg probes the content and opens whatever format it detects (HLS playlists, `ffconcat`, image sequences, every rarely used demuxer and decoder).
  - There is no `-protocol_whitelist`.
  - `create_subprocess_exec` hands ffmpeg the service's whole environment: `AI_SERVICE_SECRET`, the `app_ai` database URL and `GOOGLE_API_KEY`.
  - There is no RLIMIT, thread cap or uid separation.
  - The ai pod has `allowMetadataServer: true` in production. The VM's service account behind it signs for and writes the whole media bucket.
- **Why:** Skipping ClamAV is fine, because ClamAV never protected ffmpeg anyway. The real exposure is that one ffmpeg demuxer or decoder bug, or a probe trick, compromises the AI service. With `AI_SERVICE_SECRET`, an attacker can forge calls as any user and org, and the metadata server gives them every member's media. The docs claim a sandbox that the default path doesn't have.
- **Fix:**
  1. Pin the demuxer from `request.contentType`: `-f matroska` for `video/webm` and `-f mov` for `video/mp4`, placed before `-i`, in both `speech_args` and `cut_args`.
  2. Add `-protocol_whitelist file` before `-i`.
  3. Check the first slice's magic bytes before running ffmpeg: EBML `1A45DFA3` for WebM, an `ftyp` box for MP4.
  4. Run ffmpeg with a minimal `env={"PATH": …}`, `-threads 2`, and `resource.setrlimit` for address space, CPU and file size through `preexec_fn`.
  5. In production, refuse to clip in-process: make `CLIPPER_URL` required when `NODE_ENV=production`, or keep recording behind a flag until the Cloud Run clipper is up.
  6. Correct the "sandbox" wording in the service docstring and in docs/files.md.
  7. Add a test that feeds an `#EXTM3U` file as a slice and expects RECORDING_CLIP_FAILED.

## Important

### I1. Clip jobs queued by the maintenance task get none of the queue's options

- **Where:** `apps/worker/src/maintenance/maintenance.module.ts:9-13` registers `recording` with no `defaultJobOptions`. `maintenance.processor.ts:178-182` adds jobs to it straight through `QueueOf`. `packages/jobs/src/producer.ts` `createProducer` is the only place that applies `queues.recording.options`.
- **What:** Jobs from `finish_idle_recordings` run with BullMQ's defaults: `attempts: 1`, no backoff, and no `removeOnComplete` or `removeOnFail`.
  - `ClipProcessor.process` computes `final` from `queues.recording.options.attempts` (5). On a first-try failure (clipper outage, `FootageMissing`), `final` is false, so the attempt is never marked failed. The job has no retries left.
  - The failed job stays in Redis forever under the attempt's id, so any later add with that `jobId` is ignored.
  - The attempt sits in `waiting` in a done session for good.
- **Fix:** Add with `createProducer("recording", redis)` in the maintenance task, or pass `defaultJobOptions: queues.recording.options` to `registerQueue`. Add a test asserting `job.opts.attempts === 5` for a job the maintenance task queued.

### I2. Ended attempts in a done session can wait forever

- **Where:** `packages/db/prisma/migrations/20261018210000_recording/migration.sql:249-251` (`finish_idle_recordings` only takes `status = 'recording'`). `recording.service.ts:293-312` (`finish` sets an open attempt's `endMs` to null). `packages/contracts/src/recording.ts:74-91` (`footageThrough` needs `sliceCount`, or the slice past the end, plus every slice from 0).
- **What:** After Done, an attempt becomes ready only through a client call: `closePart`, or `completeSlice` for the missing slices. Several cases strand it in `waiting` forever:
  - The member taps Done and closes the tab before the queue drains. The spec expects exactly this ("Done … can be left: it resumes next visit"), and the next visit may never come.
  - A slice is dropped for good: `VALIDATION_FAILED` for a Safari slice over 8 MB is in the client's `FINAL` set, which leaves a gap.
  - Combined with I1, a failed maintenance job never comes back.
- **Fix:** Widen the sweep to `status = 'done'` sessions that still have open parts or waiting attempts once `updated_at` is older than the idle window. Close their parts to the contiguous run and return their waiting attempts, as for idle sessions. Have the clipper fail an attempt whose footage ends before its start.

### I3. Deleting a session (or the demo purge) races an in-flight clip and can leave a take behind

- **Where:** `recording.service.ts:315-324` reads `clipFiles` and deletes those files, then deletes the session. `apps/worker/src/recording/clip.processor.ts:167-194` and `:247-286` create the file, set `attempt.file_id`, store the bytes and call `createTake` as separate steps.
- **What:**
  - If the worker sets `file_id` after `remove` has read `clipFiles` but before the session row goes, the file and its take survive "delete this session". The final attempt update throws, the retry finds the attempt gone and returns, and a ready take of footage the member deleted stays in My media.
  - If the session goes before `file.create`, a `processing` file row is orphaned. The 24 h stale cleanup catches that one.
  - The spec's privacy table requires "delete this session deletes raw footage and clips now".
- **Fix:** Fix it in the database rather than in the call order. Add an `AFTER DELETE` trigger on `app.recording_attempt` that deletes `files.file` where `id = OLD.file_id`, which cascades to the take. In the worker, create the file and set `attempt.file_id` in one transaction that fails when the attempt is gone. Before `createTake`, check that the attempt still exists, and delete the file if it doesn't.

### I4. The limits aren't atomic, and the 20 minutes counts durations the client declares

- **Where:** `recording.service.ts:385-401` (`withinLimits`: two aggregate reads), then `recording.repository.ts:175-192` (`signSlice` upsert), with no lock between them. `uploadSlice` doesn't take the session lock.
- **What:**
  - Concurrent `uploadSlice` calls all pass the check before any of them inserts. The rate limit allows 600 an hour, so a burst of N parallel calls overshoots the 1 GB by up to N × 8 MB.
  - The session's 20 minutes is the sum of the `durationMs` the client sends. A client that declares 1 ms per slice records without limit, up to the byte cap.
  - The demo account shares one user, so one visitor can fill the demo's 1 GB for everyone.
- **Fix:** Check and insert under the session lock plus `pg_advisory_xact_lock(hashtext(user_id))`, in one statement: `INSERT … SELECT … WHERE (SELECT coalesce(sum(size),0) …) + $size <= cap`. Treat bytes as the hard limit. Either derive a plausible duration from size (for example, refuse `size / durationMs` beyond a sane bitrate) or check that `startMs` continues from the previous slice's end.

### I5. In-process clipping isn't sized for the ai pod

- **Where:**
  - `deploy/charts/stack/values.yaml:249`: KEDA scales the worker on `recording`, up to 3 replicas in production.
  - `apps/worker/src/env.ts`: `RECORDING_CONCURRENCY` defaults to 2.
  - `apps/ai/app/clipping.py:219`: `LocalClipper` has no semaphore.
  - `deploy/environments/production/stack.yaml:11-13`: the ai pod's memory limit is 768Mi.
- **What:** Up to six concurrent libx264 encodes at 720p, each using every core of the VM, can run in the pod that serves plans, takes and publishing. Each can also write up to 1.2 GB (`MAX_FOOTAGE_BYTES`) to the pod's `/tmp`. The likely outcomes are OOM kills of the AI service and CPU starvation of the API on the one 16 GB VM.
- **Fix:** Put an `asyncio.Semaphore(1)` around `LocalClipper.clip`, add `-threads 2` and nice ffmpeg. Better, require the Cloud Run clipper in production (see C1).

### I6. A retried end mark ends the next attempt

- **Where:** `recording.service.ts:433-453`.
- **What:** `endAttempt` ends whatever attempt is open, and only falls back to `attemptEndingAt` when none is. Take the sequence end A at 20 s (answer lost), start B at 25 s, then the client retries end A. The retry ends B at `max(20 s, 25 s) = 25 s`: a zero-length attempt that the clipper fails, so B's take is lost. A retried end in a later part (`endMs` null) or with a clock that went back (clamped) isn't found by `attemptEndingAt` either, and answers RECORDING_ATTEMPT_NOT_OPEN.
- **Fix:** Before ending the open attempt, look for an attempt already ended by this mark. Match on `(part, atMs)` and on the transformed end (`endOf`). Refuse an end whose `atMs` comes before the open attempt's start, so it doesn't end a different attempt.

### I7. The shared demo account breaks "demo guests never see each other's footage"

- **Where:** `apps/api/src/rpc/procedures.ts:60-61` (demo is one shared user on this base). `recording.service.ts:109-117` lists and reads sessions by `userId`.
- **What:** Until private guest workspaces land (slice 7, `feat/mm/v2-demo-guests`), every demo visitor is the same user. They see each other's sessions, attempts and takes, the takes being clips of their continuous recording with chat. They also share the 1 GB, the 600-slice hourly rate limit and the 30 sessions an hour.
- **Fix:** Either refuse `recording.start` for `demo` until slice 7 merges, or require slice 7 to merge first and note that in the PR.

## Minor

- **M1. State-machine races.**
  - `mark` checks `recording()` and `session.pauses` before taking the lock (`recording.service.ts:219-229`). A mark that commits after a concurrent Done or pause can open an attempt in a done session (never closed or swept) or inside a pause.
  - A double Done rewrites `finished_at` (`:296-308`).
  - Re-read status and the open pause after `lockSession`. Use `updateMany where status='recording'` in `finish`. Consider partial unique indexes for at most one `open` attempt per session and one unresumed pause per session.
  - Complete versus Done is safe: `clipReady` dedupes by `jobId`, and `clipping()` is conditional.
- **M2. Docs.**
  - `docs/deploy.md:225` says the ai pod has "512 MiB"; production gives it 768Mi.
  - The `_helpers.tpl:206` comment says `optional: true` lets "an environment without that service still start". With `AI_URL` always set, a missing key makes `createClipClient` throw and the worker crashloops.
  - The lifecycle rule in `docs/deploy.md:280-290` isn't applied yet. Until it is, a slice PUT through a still-valid URL after its session was deleted (the URL lasts 10 minutes, the cleanup runs hourly) is never deleted.
  - Cloud Run's `/tmp` is in memory. A part near `MAX_FOOTAGE_BYTES` won't fit in `--memory=2Gi`.
- **M3. Tests.**
  - `apps/worker/test/recording.integration.test.ts:103-111` stopped verifying the worker's JWT signature (7dff873). It now decodes the claims without checking them, so wiring the wrong secret would pass.
  - `test_clipping.py` builds its WebM with ffmpeg, which writes Cues and a duration. MediaRecorder's WebM has neither, and Safari's fMP4 isn't tested. Generate with `-f matroska -live 1` (or `-cues_to_front 0` and no index), and add an fMP4 case.
  - Nothing tests jobs queued by the maintenance task (I1), the races (I3, M1), or an end mark retried after a new start (I6).
- **M4. Idempotent take creation is check-then-insert.** `apps/ai/app/director.py:700-707` has no unique index on `ai.director_take(file_id)`, so a stalled-job double run could insert two takes. Add a unique index and `ON CONFLICT DO NOTHING`.
- **M5. Client queue.**
  - There is no 5-minute cap (spec 6.14).
  - `IndexedDbSliceStore.all()` runs `getAll` on every loop iteration (`slice-store.ts:141-148`; `upload-slices.ts:126`), which is O(n²). IndexedDB already returns rows in key order, so a cursor with `count 1` would do.
  - A persistent error outside `FINAL` (FORBIDDEN after leaving the workspace) blocks the whole queue, across sessions, at the 30 s retry forever.
  - Memory is fine: Blobs read back from IndexedDB are handles backed by disk.
- **M6. Snapping.** Snapping uses silencedetect around the marks rather than the browser's speech edges (a documented deviation). `_nearest` picks the nearest edge in either direction, so chatter just before a late mark can become the start. Acceptance asks for "none containing the chat". Prefer the first onset at or after `mark - reach`. An end mark in a later part, and Done with an attempt open, both run the attempt to its part's end, so up to 60 s of chatter can end up in the take.
- **M7. Smaller API points.**
  - `start` doesn't refuse when storage is off; the first slice then fails FEATURE_DISABLED and is dropped.
  - `shotOf` calls the AI service's `getPlan` on every mark, adding latency on the Live path.
  - `keepFootageOf` runs after `saveCut`'s write and outside it, so a failure answers 500 for a cut that was saved.
  - The spec's Cloud Storage compose was replaced by a full download from slice 0 per attempt. That's fine at this scale, but it's about 200 MB per attempt late in a session.
- **M8. Migration notes.**
  - `CREATE POLICY` on `files.file` takes ACCESS EXCLUSIVE briefly. That's bounded by `lock_timeout`; just be aware of it on a busy table.
  - `recording_attempt` and `recording_pause` have no foreign key `(session_id, part_index)` to `recording_part`.
- **M9. Commit hygiene.** 7dff873 `feat(infra)` also carries client, contract and worker-test edits, and the `prisma format` realignment of schema that 624ceb0 introduced, so 624ceb0 alone would fail the format check.

## What holds up

- **Presigned uploads:**
  - The content type comes from the part.
  - `Content-Length` is signed on both S3 and GCS (`packages/nest-common/src/storage.ts:123,287`).
  - The key is built from a session `find()` scopes to `(orgId, userId)`.
  - The upload URL expires after 10 minutes.
  - `completeSlice` checks the stored size before counting the slice, in one conditional `UPDATE … RETURNING`.
- **Authorization:** every procedure goes through `inOrg` and then `find(caller)` before touching parts, slices or attempts.
- **Database access:** all five tables have RLS forced on with `tenant_isolation`. The worker's grants are column-scoped.
- **Clipper rules:**
  - Pauses are walls (`within_pauses`).
  - The 60 s cap is applied after snapping.
  - Footage needed through `end + 2 s` comes from slice 0 with no gaps.
- **Retention:** the 7/14 days and 24 h rules and `keep`'s `least(created + 14 d, now + 7 d)` are right. The trigger queues deletion however a slice row goes, cascades included.
- **Client upload queue:** order is sound (slices, then the part's end), retries back off, and permanent failures drop the item and say why.

## Result

**Needs fixes.** C1 and I1 to I7 need fixing before this ships. If production is to clip in-process, C1 needs at least the pinned demuxer, the protocol whitelist and a clean environment. Otherwise recording should stay off until the Cloud Run clipper is deployed.
