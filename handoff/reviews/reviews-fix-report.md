# fix/mm/reviews: report

The branch is `fix/mm/reviews`, head `f0b68a06`. Items 0-2 (commits e048811c, 0b81e917, fe9cba7c) were merged as #39 (master 738d3c0c). The branch now holds three more commits rebased on master (2da247fe, #40). They're pushed but not merged.

## Item 0: answer schemas Vertex accepts (blocker, merged in #39)

- **Cause, confirmed.** I dumped the schema each agent sends. Four of them used keywords or shapes Vertex refuses or has never been sent:
  - `TakeReview`: `maxItems`, a `default`, a nullable `$ref`, and an optional `index`.
  - `EditorDraft`: `maxItems` on actions and choices.
  - `LocateDraft`: `minItems`/`maxItems` of 4 on `box_2d`.
  - `AnchorSightings` (align): a nullable object.
- **The other output types were already clean:** revise, create plan and brainstorm, session pass, spell check, publish copy and the planner.
- **Fix:**
  - The reviewer now answers with a new `TakeReviewDraft`: no list bounds, no defaults, no nullable objects, and an `index` that is always required.
  - `repair_review` (`app/take_review.py`) trims text at a word, cuts lists to their limits, and clamps times and the score. Text-cutting is shared with `publish_copy` in a new `app/text.py`.
  - The editor trims its lists in `reply_of`.
  - The locate box is an unbounded list, checked for four numbers.
  - The align box is four nullable numbers, validated against `Box`.
- **Guard:** `tests/test_planner_schema.py` is now `tests/test_output_schemas.py`.
  - It checks the schema each output type actually sends.
  - It fails if any agent's `output_type=` in `app/` is missing from its list.
  - On master, the review, editor, locate and align schemas failed this check.
- **One live Vertex call** (gemini-3.8-flash, `GOOGLE_VERTEX=true`) with the real reviewer prompt and the draft type succeeded. It returned a score, feedback and an index.
- **Also fixed:** two take tests already broken on master. One added a video take to a photo shot; the other didn't expect the GCS client's extra bucket read.

## Item 1: bug 4, reviews use the member's version (merged in #39)

- **Approach:** the AI service reads the version when the review runs.
  - It covers both callers (shutter and roll) and always uses the latest version.
  - The alternative of passing the version in the job was not taken: it touches two producers and freezes the version at record time.
- **Migration** `20261019010000_director_version_ai_read`:
  - `GRANT SELECT (org_id, user_id, video_id, version) ON app.director_version TO app_ai`.
  - Expand-only. Row-level security is already forced on the table. USAGE on the `app` schema already existed.
  - A db security test proves `app_ai` can read those columns but can't read other columns, update or delete.
- **`app/your_version.py`:**
  - `your_version()` validates the JSON as `YourVersion`. Invalid JSON is logged and the original shot is used.
  - `apply_shot_version()` mirrors the contract's `applyShotVersion`.
  - `told()` formats the memory notes.
- **The review prompt** now says "The shot, as they're filming it" and "What they've told you (always holds)". `REVIEW_INSTRUCTIONS` says never to ask for a replaced place or setup. The editor's AI context uses the version's shots too.
- **Titles:**
  - Optional `title` (≤80) added to `shotVersionSchema`, Python `ShotVersion`, `RevisedShotDraft` and `apply_revision`, and to the `adapt_shot` args and declaration.
  - `REVISE_INSTRUCTIONS` tells Gemini to retitle shots that name the old place.
  - `applyShotVersion` uses the title, so the editor board, the shoot screen and the live brief show it.
  - `version-gaps.tsx` now goes through the version as well.
- **Tests:**
  - An outdoor plan shot with an indoor version: the prompt has "At your desk", "Intro at your desk" and "- place: Inside", and has neither "outdoors" nor the old title. It fails without the fix.
  - Another workspace's version is ignored.
  - A malformed version falls back to the original shot.
  - The editor request uses the version's titles.
  - Unit tests cover `apply_shot_version` parity, revise titles, the web `yourVersion` title, the `VersionGaps` component, and live `adapt_shot` renaming and bounds.

## Item 2: bug 5, "couldn't review" (merged in #39)

- **Bounded concurrency:**
  - Reviews have their own queue, `ai-review`. The AI worker runs it at concurrency 2 (`REVIEW_CONCURRENCY`), so plans and drawings no longer wait behind a roll's burst.
  - `ai-director` still runs `review-take` jobs the previous release queued. Drop that in a later release.
  - KEDA now also scales on `ai-review` (`deploy/charts/stack/values.yaml`).
- **Backoff:**
  - `ai-review` retries 6 times from 15 s: up to 465 s, about 8 minutes.
  - Python's bullmq ignored `jitter`. Jobs Python adds now use the backoff type `exponential-jitter`, which its workers compute the way Node does (`jittered_backoff`; the bullmq `settings.backoffStrategy` hook).
- **Download link lifetime:** `TAKE_REVIEW_READ_S` (6 h) in packages/jobs is used by apps/api `addTake` and the clipper's take read. A packages/jobs test asserts it is more than 10× the retry window.
- **Partial reservations:**
  - `reserve` now refuses when less than a quarter of the cap is left (`FLOOR_SHARE`). Images and clips require the whole cap through `least=`.
  - A review that runs over a partial reservation fails with `AI_BUDGET_EXCEEDED`.
- **Logging and hangs:**
  - Every review failure's activity line carries `cause` (the error's type).
  - An unexpected error outside the model call no longer leaves a take "reviewing" after its last attempt.
- **Tests:** the review job lands on the new queue with the jittered backoff; the review processor fails only on attempt 6; a real worker subprocess plans and reviews from both queues; 429 and 503 are retried, then fail with the cause logged; a partial reservation gives a budget failure, and too little left means Gemini isn't called; a settle failure is retried and fails on the last attempt; jittered-backoff unit tests; the `addTake` expiry check in api integration.
- **Also fixed:** test_create's plan fixture was missing the required `brands` field, which broke four create tests and one asset test on master.

## UAT run 1 items (on the branch after #39, not merged)

- **UAT1-34, no asset slot (commit 1ba49170).**
  - **Root cause:** deployment. The Cloud Run `director-indexer` runs `ai:sha-58825810`, the first Director image (#8), from before assets (#24). Production is v1.6.0.
  - **Guard:** the indexer now returns its `release`. A worker on another release logs an error, stops using that indexer, and writes plans locally, counting both runs. docs/deploy.md now says to deploy the indexer on every release.
  - **Still needed:** deploy the indexer at production's commit (docs/deploy.md, "The Cloud Run indexer"). I didn't deploy anything.
  - `director-clipper` runs `sha-5e4a9246`. Its code hasn't changed since, so it isn't stale.
- **UAT1-17, empty takes (commit 97cb278d).**
  - **Reproduced** with a test: slices that claim more footage than was recorded, with marks past the real end. ffmpeg exits 0 and writes an MP4 with no picture.
  - The clipper now counts the cut's frames (ffmpeg `-map 0:v:0 -f null` progress). It fails the attempt as `RECORDING_CLIP_FAILED` when the cut has fewer than 15 frames (0.5 s at 30 fps).
  - Director's pick only ever comes from scored takes. The editor's fallback, used when a shot has no scored take, no longer picks a failed take while a playable one exists.
- **UAT1-26 (commit f0b68a06).** "What you'll need" now goes by what the shots actually hold:
  - a shot with a line: "You, talking to the camera";
  - a person in frame but no line: "You on camera, without talking" (new i18n key);
  - filmed shots with nobody in them: "Nobody on camera".

## Checks run

- Lint and check-types pass for the whole repo.
- Unit tests pass: ai (337), web (232 after the rebase), api (351), worker, jobs and contracts.
- Integration tests on stack 7: ai director, budgets, assets, create, aligning, editor, clipping, indexer and output schemas all pass. Also apps/api director and your-version, apps/worker recording, and packages/db security.
- db drift is clean.
- `bun run db:lint` flags only the existing `20261018222000_director_version` migration, not the new one.
- Stack 7 Postgres crashed into recovery once mid-run. I reran on the recovered stack.
- I didn't run `bun run db:down`, so stack 7 is still up.

## Not done (from review-python.md; left for a later pass)

- The session pass: video resolution, sizing the reservation from duration, and no retry on non-retryable errors.
- Claiming asset rows atomically.
- Re-queuing lost queue adds: `add_take`, create, and the pass's reconcile.
- Counting the proofreading call's tokens and the thought tokens.
- Letting `VEO_MODEL=` turn clips off.
- The alignment settling 0 tokens.
- The ffmpeg leak on cancel and the synchronous writes in clipping.
- create being left hanging on unexpected errors. Reviews are fixed; create isn't.
