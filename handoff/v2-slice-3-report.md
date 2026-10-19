# Slice 3 (continuous recording): server side and pipeline

Branch `feat/mm/v2-recording` (from origin/master `ae43b93`), pushed through `7dff873`.
Six commits, no PR.

## What's built

- **Contract** (`packages/contracts/src/api/recording.ts`, rules in `src/recording.ts`):
  `recording.start / sessions / session / addPart / closePart / uploadSlice /
  completeSlice / mark / pause / resume / finish / remove`. Ten new error codes with
  i18n strings; a `recording.changed` realtime nudge; branded `RecordingSessionId` and
  `RecordingAttemptId`.
- **API module** `apps/api/src/modules/recording`: a session per shoot on a ready plan.
  Each slice gets a presigned PUT for exactly its size and type under
  `recordings/<session>/<part>/<slice>`, then a complete that HEADs storage. No bytes
  pass through the services. Marks are numbered under a row lock and are idempotent:
  the same start returns the same attempt, and the same end does too. A start while
  another attempt is open ends that one. Pause ends the open attempt and records a pause
  stretch; resume only comes from the client. Done runs an open attempt to its part's
  end. An attempt is queued on the new `recording` queue once its footage is stored.
  Limits: 20 recorded minutes per session and 1 GB of footage per member.
- **DB** migrations `20261018210000_recording` and `20261018210500_recording_purge_reads`.
  They add five `app.recording_*` tables with forced RLS, `tenant_isolation`, checks and
  grants, are expand-only, and pass Squawk with a documented ignore. A trigger queues
  slice objects into `files.object_deletion`. The SECURITY DEFINER functions are
  `purge_expired_recordings` and `finish_idle_recordings`.
- **Retention**: footage is kept 7 days, and saving a video (`director.saveCut`) extends
  it to 7 days from the save, 14 days from recording at most. Demo footage is kept 24
  hours, and its takes go with it. `recording.remove` deletes the takes and the footage
  right away. A worker maintenance task (`recording-retention`, hourly) purges expired
  sessions and finishes sessions idle for 6 hours. A GCS lifecycle rule on
  `recordings/` (15 days) is documented as the backstop.
- **Clipper** (Python, `apps/ai/app/clipping.py`): it joins the part's slices from the
  first, which holds the header, using presigned reads. It runs ffmpeg silencedetect
  around the marks and snaps a mark within 1.5 s of a speech edge, with a 0.25 s pad.
  It never crosses a pause and caps a clip at 60 s. It re-encodes to H.264/AAC MP4.
  - The AI service route is `/v1/director/clips` (JWT).
  - With `CLIPPER_URL` set, the work goes to the Cloud Run entrypoint `app.clipper:app`.
    It runs from the same ai image (which already has ffmpeg) and checks the caller's
    ID token, like the indexer.
- **Worker** `apps/worker/src/recording/clip.processor.ts`:
  1. Signs reads of the slices and calls the clipper through `@repo/ai-client`.
  2. Stores the MP4 as a ready `director-take-video` file.
  3. Calls `createTake`, so the review, editor and My media work unchanged.
  4. Updates the attempt and sends `recording.changed`.

  It's idempotent: `createTake` now returns the existing take for a file it already has.
- **Client** `packages/client/src/api/recording/`: `useSliceUploader` with an IndexedDB
  queue behind a `SliceStore` seam. It resumes after a dead tab, sends in order, retries
  with backoff, reports `behindMs`, and drops a slice on a refusal no retry changes.
  Hooks for each procedure come with it. I didn't touch the shoot page components.
- **Infra and docs**:
  - The stack chart has a `secretKeys` value. The worker gets `AI_URL` and the ai
    service's `AI_SERVICE_SECRET`, the ai network policy lets the worker in, and KEDA
    scales on the `recording` queue.
  - `docs/deploy.md` has "The Cloud Run clipper". The clipper is not deployed.
  - how-it-works, files, jobs-and-events, environment, director and testing docs are
    updated.
  - CI's Python job installs ffmpeg.

## Checks

- Lint (everything), check-types, type-coverage and `bun run test`: all pass.
- `gen` makes no changes, Prisma reports no drift, and `db:lint` passes.
- Integration tests, all pass: API recording (17, against Postgres and RustFS), worker
  recording (10), and Python clipping (real ffmpeg on a generated recording, the route,
  the Cloud Run app with its ID-token checks, and RemoteClipper).
- Helm unittest: 82 tests pass.
- New code is at 100% coverage, except one branch in the API repository that the
  integration suite covers.
- I didn't run browser suites or ClamAV.
- Two `scripts/pre-push.test.ts` database tests fail locally only because the checkout
  is on `--stack 8`: they expect the default port 55432.

## Product calls (the spec is silent)

- Attempt times use each part's media clock, and a camera flip or a comeback starts a
  new part.
- An end mark in a later part ends the attempt at the end of its own part.
- Pauses are walls: an attempt is cut at the pause and never spans one.
- Snapping is done server-side with silencedetect, not with the browser's speech edges.
- Slices skip ClamAV and the files row: only the sandboxed clipper decodes them, and the
  take is our own re-encode.
- A session idle for 6 hours is auto-finished and its attempts are clipped.
- Demo takes are deleted with demo footage after 24 hours.
- Not built yet: "delete the last minute" or `discard`.

## For the controller

Deploy the clipper with `docs/deploy.md` → "The Cloud Run clipper". Then set
`CLIPPER_URL` on the ai service in production's `stack.yaml` and apply the bucket
lifecycle file. Until then the ai pod clips in-process. I stopped stack 8.
