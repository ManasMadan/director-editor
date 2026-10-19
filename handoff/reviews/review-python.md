I didn't write `review-python.md`. My instructions don't allow report files, so the full findings are below for you to save. I reviewed `origin/master` (943b9dcf) against `v1.1.0`, using a read-only export of the tree at `/private/tmp/claude-503/-Users-manas-madan-Desktop-code-director-editor/f1ddf0d8-5838-46aa-97e0-9a9cb55506ef/scratchpad/tree`. Paths below are relative to the repo root on `origin/master`.

**Verdict: not ready.** The review failures and the "film outdoors" feedback each have a clear root cause in the code.

## Findings, worst first

**[blocker] `apps/ai/app/schemas.py:941,945,948` (TakeIndex inside TakeReview), output type at `apps/ai/app/director.py:612-618` – take reviews fail on Vertex.**
- **Why:** #35 added `TakeIndex` to `TakeReview`, which the reviewer agent uses directly as its output type. Its lists set `max_length` (things 30, transcript 300, moments 20), so the schema sent to Gemini contains `maxItems`.
  - I dumped the schema and confirmed it. The installed pydantic-ai doesn't strip `maxItems`.
  - The repo's own comment at `schemas.py:28-38` says Vertex answers 400 INVALID_ARGUMENT to any `maxItems`. Production runs `GOOGLE_VERTEX=true`.
  - A 400 isn't retryable (`indexing.py:85`), so `_end_take` fails the take at once: "Director couldn't review this take".
  - `index: TakeIndex | None = None` also adds `"default"` and a nullable `$ref`, which `test_planner_schema.py` treats as unsafe for Vertex.
  - The tight string bounds (`reason` 160, `feedback` 300, `SpokenWord.text` 60, `visible` 800) also fail validation when Gemini overruns them. pydantic-ai then retries with the whole video again, doubling input tokens, before giving up.
- **Fix:** add a `TakeReviewDraft` with unbounded lists and strings, every field required and nullable, no default. Clamp it into `TakeReview` after the run, the way `ShotPlanDraft`→`repair_plan` and `PublishCopyDraft`→`tidy` already work.
- **Guard:** extend `test_planner_schema.py`'s keyword and default check to every agent's output schema. The fake Gemini accepts any schema, so nothing caught this.

**[blocker] `apps/ai/app/schemas.py:1537-1538` (EditorDraft), agent at `director.py:619-626` – every editor request fails on Vertex.**
- **Why:** same bug. `actions` (`maxItems` 40) and `choices` (`maxItems` 4) go to Vertex. The run raises and the member gets UPSTREAM_UNAVAILABLE.
- **Fix:** an unbounded draft, with `reply_of` trimming to `MAX_EDITOR_ACTIONS`/`MAX_EDITOR_CHOICES`.

**[major] `apps/ai/app/schemas.py:864-868` (LocateDraft.box_2d `min_length=4, max_length=4`) – same bug for "point at it".**
- **Why:** it sends `minItems`/`maxItems` 4, which the repo's own evidence says Vertex refuses.
- **Fix:** four required nullable int fields (ymin, xmin, ymax, xmax), or an unbounded list checked in `located()`.

**[blocker] Reviews ignore the member's version and memory – `director.py:1149-1153` and `REVIEW_INSTRUCTIONS` (`director.py:281-301`).**
- **Why:** the review prompt is the original plan's shot only: `"The shot:\n" + shot.model_dump_json()`, and it tells Gemini to "compare the take with the shot: its scene, framing…".
  - The version and its notes live in `app.director_version`, which apps/api owns. They never reach this service.
  - `DirectorTakeCreate` (`schemas.py:883-896`) has no field for them, and `extra="forbid"` refuses one. apps/api's `addTake` doesn't send them either.
  - The job payload is only `{takeId, orgId, sourceUrl}`, and `app_ai` has no grant on `app.director_version`.
  - So a member who chose "indoors" is judged against "Stand outside near a tree".
- **Same root cause elsewhere:**
  - Scene checks (`_SCENE_FIELDS` at `director.py:1489` sends `scene`/`sceneLandmark`), so the camera guidance still points at the tree.
  - The session pass prompt (`session_pass.py:268`).
  - The editor context (`editor.py:editor_context`).
- **Fix (smallest):**
  1. A migration granting `SELECT ON app.director_version TO app_ai`.
  2. In `review` and `check_scene`, read the row for `(take.user_id, plan.video_id)` inside `tenant(org_id)` and validate it non-strict as `YourVersion`.
  3. Overlay the shot's `ShotVersion` (where, action, line, framing, camera) onto the shot sent, and add the memory notes as their own prompt part.
  4. Change the instruction to "the member's version replaces the original's scene, action and line; never suggest going back to it".
  5. Skip or gap shots the version marks that way.
  6. Add a test: a version with `where="your living room"` must not leave "outside" or "tree" in the prompt the fake receives.

**[major] `apps/ai/app/usage.py:102` (`min(most, left)`) plus every `UsageLimits(total_tokens_limit=…)` – reservations don't cap anything, and slivers make runs fail after they're paid.**
- **Why:** the installed pydantic-ai checks `total_tokens_limit` only after the response (`usage.py:591-605`, `_agent_graph.py:2067`), and nothing sets `count_tokens_before_request`.
  - Near the end of the allowance, `reserve` hands out a sliver (say 3k for a review that costs 20k). Gemini answers, then `UsageLimitExceeded` is raised.
  - The member sees "couldn't review" while `settle` records the full 20k, so the ledger can go past the allowance.
  - This also contributes to the review failures for demo guests and while a 200k plan reservation is in flight.
- **Fix:** have `reserve` return None, so the caller answers AI_BUDGET_EXCEEDED, when `left` is under a per-feature floor. Images already do this (`assets.py:657-665`). Or pass `count_tokens_before_request=True` where the provider supports it.

**[major] `apps/ai/app/session_pass.py:36,293-310` – the session pass fails on long sessions after spending the tokens, three times over.**
- **Why:** `PASS_TOKENS = 150_000` assumes "low media resolution" (the comment at line 34), but the agent's `ModelSettings` never sets `google_video_resolution`.
  - The planner sets MEDIUM and the settings estimate about 300 tokens/s, so ten minutes is about 180k, over the cap. A part may be 21 minutes, and there can be several parts.
  - The run is billed, then raises `UsageLimitExceeded`. Only `AppError` is caught (`:337-341`), so BullMQ retries a deterministic failure 3 times.
- **Fix:**
  1. Use `GoogleModelSettings(google_video_resolution=MEDIA_RESOLUTION_LOW)`.
  2. Size the reservation from the summed `duration_ms`, and skip (log) footage that can't fit before calling Gemini.
  3. Catch non-retryable errors (`indexing.retryable`) and end the job without retrying.

**[major] Concurrent asset jobs draw the same rows twice, Veo included – `assets.py:489-551` (`_jobs` picks `pending` and `generating`), `:606` and `:648` (unconditional `_set(status="generating")`).**
- **Why:** every picker drawing queues its own job for the whole plan (`picker.py:206-208`, job id `{plan}-assets-{row}`), and so does create (`create.py:497-505`), with worker concurrency 3.
  - Job B lists a row job A is already drawing, including a "generating" Veo clip, and draws or films it again.
  - That's two reservations and two Veo bills for one slot, both uploading to the same key.
- **Fix:** claim each row atomically: `UPDATE … SET status='generating', updated_at=now() WHERE id=:id AND (status='pending' OR (status='generating' AND updated_at < now() - interval '15 min')) RETURNING id`. Skip the row if the update returns nothing.

**[major] `apps/ai/app/aligning.py:131-157` with `settings.py:187-198` – ffmpeg decodes member takes inside the ai pod, with all its secrets, in production.**
- **Why:** `read_frames` runs `ffmpeg -i <presigned url>` directly. It has no `-protocol_whitelist`, no pinned demuxer (format is probed) and no `app/jail.py`, and it inherits the full environment (AI_DATABASE_URL, AI_SERVICE_SECRET, GOOGLE_API_KEY).
  - `ALIGNER_URL` isn't required in production, and production's `stack.yaml` doesn't set it, so this runs in the pod.
  - That contradicts the policy the clipper enforces (`_production_clips_on_cloud_run`).
- **Fix:**
  1. Require `ALIGNER_URL` (HTTPS) when `NODE_ENV=production`.
  2. In `read_frames`, run through `JAIL`, add `-protocol_whitelist https,tls,tcp` (plus `http` outside production), and add `-f mov|matroska` from a `contentType` on `MatchCutClip`.

**[major] Takes and created plans can hang forever on unexpected errors – `director.py:1112-1163` (review) and `create.py:402-416` (write).**
- **Why:** both set the row to `reviewing`/`analyzing` and then call `_reserve`, `_download` or the final DB update outside any catch-all. On the last attempt, a database or Redis error leaves the take "reviewing" (or the plan "analyzing") for good.
  - `analyze` already handles this (`director.py:786-795`).
- **Fix:** the same `except Exception: if final: fail; raise` around the whole body.

**[minor] Lost queue adds are never re-queued:**
- `add_take` returns early when the take already exists (`director.py:1050-1051`). A take whose first `add_review` failed stays `pending` forever. Fix: re-add while `take.status == "pending"`; job id = take id dedupes.
- `create.py:379-385`: same, and the stuck plan counts against `CREATE_PER_DAY`.
- `session_recordings.py:331-334`: on a retry the pass-added attempt is already in `known`, so `reconcile` treats it as "same" and the attempt is never clipped. Fix: re-queue the existing attempt when its status is still `clipping`.

**[minor] `apps/ai/app/assets.py:250-266` and `:172-174` – model calls outside the token accounting.**
- **Why:** the proofreading call (`_checker.run`) has no reservation, no `usage=` and no `UsageLimits`, and its tokens are never counted. Separately, `_drawing` counts `candidates_token_count` only and drops `thoughts_token_count`, which the settings comment says Nano Banana uses.
- **Fix:** pass a `RunUsage` and add it to `used`, and include thought tokens.

**[minor] `apps/ai/app/settings.py:158` – `VEO_MODEL=` can't turn clips off.**
- **Why:** `env_ignore_empty=True` makes an empty value fall back to the default, which I verified. That contradicts `docs/environment.md` ("Empty turns clips off").
- **Fix:** `veo_model: str | None = Field(default=None, …)`, with the default shipped in `.env.example`, or an explicit `VEO_ENABLED` flag.

**[minor] `director.py:1375-1393` – a local alignment that fails after Gemini answered settles 0 tokens.**
- **Why:** `used` only changes on success or `AppError`. A `cv2.error` or `ValueError` in `align_frames` or `jpeg` records nothing and returns INTERNAL.
- **Fix:** default `used` to the full reservation, as `_index_and_settle` does.

**[minor] `director.py:1127-1140` – a review job that runs after the 30-minute read URL expires gets 403.**
- **Why:** 403 isn't retryable, so the review fails permanently when the queue is backed up (a session's burst of takes behind Veo or pass jobs).
- **Fix:** carry the file key and sign the read when the job runs, or treat 403 on the source as retryable after re-signing.

**[minor] `aligning.py:158-163` – an ffmpeg process leaks on cancellation.** Only `TimeoutError` kills it, and `gather` leaves the sibling read running. Fix: reuse `process.run_process`'s kill-on-cancel.

**[minor] `clipping.py:330-355` – synchronous writes of up to 1.2 GB inside `async def`.** These block the ai service's event loop when cutting locally. Fix: `asyncio.to_thread` or `aiofiles`-style chunked writes.

**[minor] `session_recordings.py:25-27,162-180` – typing and suppression issues.**
- Its pyright ignores aren't listed in `docs/testing.md`, and the one on line 26 has no reason after it.
- It builds its own BullMQ `Queue`, while `queues.py` says BullMQ calls are confined there.
- Fix: move `ClipQueue` into `app/queues.py`.

**[minor] Item 2 gaps:**
- `schemas.py:1541-1570`: `EditorAction`, `EditorChoice` and `EditorReply` fields are unconstrained.
- `apps/api/src/modules/director/limits.test.ts` checks only locate and the plan. None of the new request models (EditorRequest, ReviseRequest/YourVersion, BrainstormRequest, MatchCutRequest, ClipRequest) are compared with the API's limits.

## Verified clean
- **Auth:** every new route takes `CallerDep`. The clipper and aligner verify the Google ID token's audience and invoker.
- **Tenancy:** every query goes through `tenant(org_id)`, with the org from the caller or from a job this service queued. Takes, cuts and picker rows also filter by the caller's user.
- **Errors:** every code is the generated `ErrorCode` Literal. Presigned URLs are stripped from logs and from BullMQ failure records.
- **Clipper ffmpeg:** argv only, `-protocol_whitelist file`, pinned demuxer, jail with a PATH-only environment and rlimits, timeout kill and reap.
- **GCS compose:** runs in `to_thread`.
- **Settings:** new settings are in `.env.example` and `docs/environment.md`.
- **Lint:** ruff check and format pass on the exported tree.
- **Types:** basedpyright strict is clean except `aligning.py`. That file is inconclusive because the local venv lacks numpy and opencv.

## Not run
`bun run --filter @repo/ai check-types`, `lint` and the pytest suites weren't run against `origin/master`. The main checkout is on an old branch, so I ran ruff and basedpyright from the existing venv against the exported tree instead.

**Verdict: not ready.**