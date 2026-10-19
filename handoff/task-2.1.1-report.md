# Task 2.1.1 report: indexing works for any Short

Worktree: `/Users/manas.madan/Desktop/code/director-editor/.claude/worktrees/agent-a8d4560cf42b3765d`
Branch: `worktree-agent-a8d4560cf42b3765d` (from `feat/mm/director-hackathon`)

Same `.superpowers/` caveat as the 2.1.2 report: not tracked by git, didn't exist in this
worktree, so this lives at the worktree's own copy of the path.

## Scope

The brief (prompt + schema for any Short) plus the coordinator's four live-tested
findings: the critical Vertex schema bug, model split (INDEX_MODEL vs DIRECTOR_MODEL)
with retry+fallback, video settings (fps, media resolution), and live verification
against real Vertex AI with the given seeds.

## 1. The critical bug: Vertex 400s on any array bound

**Root cause confirmed live** (see "Live verification" below): Vertex AI refuses the
planner's request with 400 INVALID_ARGUMENT whenever the sent JSON schema has a
`minItems`/`maxItems` anywhere in it, on every model and output mode. Two changes, both
needed:

- **The sent schema carries none.** `Shot.steps`, `Shot.script`, `TargetPose.keypoints`
  and `ShotPlan.shots` (`apps/ai/app/schemas.py`) no longer have a `min_length`/
  `max_length` Field constraint — the only place a list's length showed up as
  `minItems`/`maxItems`. A new `_LenientGoogleJsonSchemaTransformer` in
  `apps/ai/app/director.py` (subclassing pydantic-ai's `GoogleJsonSchemaTransformer`,
  wired in through a model `profile=` override) also strips the two keywords from
  whatever reaches the wire, as a second line of defense if a length constraint ever
  comes back on one of those fields.
- **The limit moves to `repair_plan`.** `apps/ai/app/plan_repair.py` now trims: shots to
  `MAX_SHOTS` (keeping the earliest, after the existing sort/overlap/sliver repair),
  steps to `MAX_SHOT_STEPS` (10), script lines to `MAX_SCRIPT_LINES` (20), pose keypoints
  to `MAX_POSE_KEYPOINTS` (13), and synthesizes one step from the shot's `scene` when
  Gemini leaves a shot with none (`ShotPlan.shots` can no longer have a schema-level
  minimum either, so a step list can legitimately come back empty). A plan with literally
  no shots raises `ValueError` — there's nothing to repair that into.
- `PLAN_INSTRUCTIONS` still states the same numeric limits as prose (12 shots, 10 steps,
  20 script lines, 13 keypoints), since they no longer reach Gemini as a schema bound.

**Chose this over a duplicate "lenient" output model**: one Pydantic `ShotPlan` stays
the source of truth for the OpenAPI contract and for parsing Gemini's answer; only the
schema *sent* to Gemini is transformed, and only the one thing Vertex actually rejects
is touched.

**Contract follow-through** (the brief explicitly asked for this, since `bun run gen`
regenerates from the Python models): `packages/contracts/src/api/director.ts`'s
`shotPlanSchema.shots` dropped its `.min(1).max(DIRECTOR_MAX_SHOTS)`;
`apps/api/src/modules/director/limits.test.ts`'s `maxItems` assertion on `shots` now
asserts `toBeUndefined()` instead, with a comment explaining why; `bun run gen` was
run, regenerating `apps/ai/openapi.json`, `apps/api/openapi.json` and
`packages/ai-client/src/generated/*` (diff is exactly the `minItems`/`maxItems` removal
on `shots`, nothing else).

## 2. Models: INDEX_MODEL / INDEX_FALLBACK_MODEL, with retry and fallback

- `apps/ai/app/settings.py`: `index_model` (default `gemini-4-argon`) and
  `index_fallback_model` (default `gemini-3.1-pro-preview`), both plain required-with-
  default strings (no half-configured state possible, unlike `DIRECTOR_MODEL`, since
  they always have a value and only matter once Director itself is already configured).
  Added to `.env.example` (both `gemini-mock`, matching `DIRECTOR_MODEL`'s local-dev
  pattern) and `docs/environment.md`.
- `Director` now builds two more `Agent`s for planning: `self._planner` (`INDEX_MODEL`)
  and `self._planner_fallback` (`INDEX_FALLBACK_MODEL`), both with the lenient schema
  profile; `self._scout`/`self._reviewer` are unchanged (`DIRECTOR_MODEL`).
- `Director._run_planner`: tries `self._planner` up to `PLANNER_RETRIES + 1` times
  (3 total), with a short backoff (`PLANNER_RETRY_BACKOFF_SECONDS * (attempt + 1)`)
  between retries, only for a retryable error (5xx/429, the existing `retryable()`
  helper); a non-retryable error (a refusal, a broken contract) raises immediately —
  a different model watching the same unwatchable video wouldn't help. Once the
  primary's retries are exhausted, `self._planner_fallback` is tried once; whatever it
  raises (or returns) is the call's outcome. The same `RunUsage`/`UsageLimits` carry
  across every attempt, so the token cap is enforced cumulatively, not per attempt.
- `analyze()` now calls `_run_planner` and moved `repair_plan` inside the same `try`, so
  a `ValueError` from an empty-shots plan is handled by the existing failure path
  (logged, `DIRECTOR_ANALYSIS_FAILED`, not retried) instead of crashing the job.

## 3. Video settings: media type, fps, resolution

- `youtube_video()` now sets `vendor_metadata={"fps": INDEX_VIDEO_FPS}` (3.0) on the
  `VideoUrl` — pydantic-ai 2.53 maps this straight into the request's `videoMetadata`
  (confirmed reaching the wire; see the test below). `media_type="video/*"` is
  unchanged (already fixed for Vertex's YouTube-URL 500 before this task).
- The planner's `model_settings` is now `GoogleModelSettings` with
  `google_video_resolution=MediaResolution.MEDIA_RESOLUTION_MEDIUM` added (confirmed
  reaching the wire as `"mediaResolution": "MEDIA_RESOLUTION_MEDIUM"`), alongside the
  existing `thinking`/`timeout`. Scout and reviewer keep plain `ModelSettings` — they
  don't watch a YouTube video, so neither setting applies to them.

## 4. Live verification (real Vertex AI, this session)

Ran the actual `app.director` code (`create_index_model`, `PLAN_INSTRUCTIONS`, the
planner's `model_settings`, `repair_plan`) against real Vertex, authenticated with
`gcloud auth print-access-token` through `GoogleCloudProvider(credentials=...,
project="project-18e15b18-c92e-44bb-9bf", location="global")`, for all three seeds on
all three models the coordinator named. All nine succeeded — no 400, no schema
rejection, every plan repaired cleanly:

```
gemini-4-argon:
  _HonL1arbaA (recipe): 9 shots, steps 2-3, script 1 line each, 0 keypoints (no person)
  8OLAi6Eba98 (text-only): 1 shot, 4 steps, 4 script lines, 6 keypoints
  vUZWe5kAsSM (dance): 1 shot (38.3s), 8 steps, 0 script lines, 13 keypoints

gemini-3.1-pro-preview (the fallback model):
  _HonL1arbaA: 11 shots, steps 1-4, script 1-2 lines, 0 keypoints
  8OLAi6Eba98: 1 shot, 5 steps, 4 script lines, 4 keypoints
  vUZWe5kAsSM: 1 shot (38.2s), 1 step, 0 script lines, 7 keypoints

gemini-3.8-flash (DIRECTOR_MODEL, production's interactive model):
  _HonL1arbaA: 10 shots, steps 1-2, script 1-2 lines, 0 keypoints
  8OLAi6Eba98: 1 shot, 5 steps, 4 script lines, 13 keypoints
  vUZWe5kAsSM: 1 shot (38.0s), 8 steps, 0 script lines, 13 keypoints
```

Every shot's `purpose` reads as a role + feeling ("hook: entice the viewer immediately
with a delicious, mouth-watering bite", "Payoff: glossy, satisfying decoration for the
final finish"); the text-only seed and the dance seed (fast cuts, no narration) both
produced sensible single- or few-shot plans without choking; the no-person case
correctly left keypoints empty. The script used to run this (not committed — needs real
GCP credentials and isn't reproducible in CI) was a one-off, kept only in the scratchpad.
Not separately tested live: the explicit `ToolOutput`/`NativeOutput` wrapper modes (the
app always uses the implicit default, tool mode); the fix is schema-content-based and
applies through the same `json_schema_transformer` regardless of mode, per
pydantic-ai's source, but I didn't construct a second live call to prove that
independently.

## TDD / test evidence

- `apps/ai/tests/test_plan_repair.py`: 4 new tests — shots trimmed to `MAX_SHOTS`
  (keeping the earliest), steps/script/keypoints trimmed together, a step synthesized
  when a shot has none, and the empty-shots `ValueError`. 12 tests total, plan_repair.py
  at 100% line+branch coverage.
- `apps/ai/tests/test_director.py`: extended `extra_env` to also set `INDEX_MODEL`/
  `INDEX_FALLBACK_MODEL` (existing tests all route through the one fake Gemini path,
  same as `DIRECTOR_MODEL`, so the 28 pre-existing tests needed no other change — I
  confirmed they fail without this and pass with it). New:
  - `test_the_analysis_watches_the_short_and_stores_the_plan` (existing test, extended):
    asserts fps and media resolution reach the request, and that neither `minItems` nor
    `maxItems` appears anywhere in the sent schema.
  - `test_a_plan_with_no_one_in_it_is_accepted` / `test_a_plan_with_no_speech_is_accepted`
    (the two the brief names): canned plans via the fake Gemini, asserting the service
    accepts them end to end (`ready`, correct `pose.keypoints`/`script`/`audio`).
  - `test_the_planner_retries_then_falls_back_to_the_index_fallback_model`: a 503 on
    the primary model's path, a working handler on a distinct fallback path; asserts the
    primary was hit exactly `PLANNER_RETRIES + 1` times and the fallback exactly once,
    and the plan ends up `ready`. This is a real regression test, not incidental
    coverage: it independently proves the retry count and that the fallback model is
    actually the one that answers.
  - 31 tests total.
- Full merged coverage (`bun run --filter @repo/ai coverage`): every file in `app/` and
  `evals/` at 100%, including `director.py` (289 stmts, 64 branches, 0 missed) and
  `plan_repair.py` — no dedicated coverage-only tests were needed beyond the ones above;
  the retry loop, the fallback call and the schema transformer are all exercised by the
  existing error-path tests (403/400 for the non-retryable branch, 503/500 for the
  retryable-then-fallback branches) plus the new dedicated retry test.

## Commands and output

- `bun run --cwd apps/ai lint`: clean.
- `bun run --filter @repo/ai check-types`: `0 errors, 0 warnings, 0 notes`.
- `bun run --cwd apps/ai test`: `100 passed, 72 deselected`.
- `bun run --filter @repo/ai test:integration -- tests/test_director.py`: `31 passed`.
- `bun run --filter @repo/ai coverage`: `TOTAL 1819 0 232 0 100%`, `172 passed`.
- `bun run lint` (repo-wide): all green (one pre-existing, unrelated warning in
  `scripts/image-scan.test.ts`).
- `bun run check-types` (repo-wide, runs `bun run gen` as a dependency): all 28 tasks
  green; this is what regenerated `openapi.json` (both services) and
  `packages/ai-client`.
- `bun run --filter @repo/api test`: `158 passed` (includes the updated
  `limits.test.ts`).
- `bun run --filter @repo/contracts test`: `32 passed`.
- `bun test scripts/env-docs.test.ts scripts/claude-setup.test.ts`: `107 pass`.
- `bun scripts/suppressions.ts`: no violations (one new suppression added and
  documented: `apps/ai/tests/test_director.py`'s `redis_client().flushdb()`, same
  redis-py-is-untyped reason as the other test files).

## Files touched

`.env.example`, `apps/ai/app/director.py`, `apps/ai/app/plan_repair.py`,
`apps/ai/app/schemas.py`, `apps/ai/app/settings.py`, `apps/ai/openapi.json` (generated),
`apps/ai/tests/test_director.py`, `apps/ai/tests/test_plan_repair.py`,
`apps/api/openapi.json` (generated), `apps/api/src/modules/director/limits.test.ts`,
`docs/director.md`, `docs/environment.md`, `docs/testing.md`,
`packages/ai-client/src/generated/types.gen.ts` (generated),
`packages/ai-client/src/generated/zod.gen.ts` (generated),
`packages/contracts/src/api/director.ts`.

## Known gaps / judgment calls

- `NativeOutput`/`ToolOutput` explicit wrapping wasn't separately live-verified (see
  "Live verification" above) — the app never uses them explicitly, so this wasn't a gap
  in what's shipped, just in how exhaustively the fix was proven live.
- Didn't touch `docs/director.md`'s diagram or the rest of its walkthrough beyond one
  sentence on `INDEX_MODEL`/`INDEX_FALLBACK_MODEL` in "Turning it on" — the brief's and
  coordinator's asks were about `apps/ai`'s code, settings and the contract, not a
  rewrite of the user-facing doc.
- `PLANNER_RETRY_BACKOFF_SECONDS` (1.0, linearly scaled by attempt) and `PLANNER_RETRIES`
  (2) are hardcoded constants in `director.py`, not environment variables — the brief
  didn't ask for them to be configurable, and the repo's own convention is constants for
  this kind of timeout/retry tuning (`WATCH_TIMEOUT_SECONDS` et al. are the same).

## Commit

Left uncommitted, per the controller's instruction (and my own policy that only genuine
approval, not a relayed claim of it, authorizes a commit I make myself). Ready to commit
as a single `feat(ai)` change, or split further if preferred (schema/repair_plan vs.
model/retry wiring vs. prompt text), whenever the controller does it.

Update: the controller committed this work as `f887a14` on this worktree's branch.

## Fix round 1 (python-reviewer + CI's oasdiff, against base `2752443`)

### CRITICAL 1 — the array-bound removal broke the api-compat gate

Root cause of the review finding: I had removed `Shot.steps`/`Shot.script`/
`TargetPose.keypoints`/`ShotPlan.shots`'s `min_length`/`max_length` from the *stored and
returned* `ShotPlan` itself, so the public OpenAPI contract lost `minItems`/`maxItems` on
those four — a real breaking change (oasdiff: 4 errors in `apps/api/openapi.json`, 12 in
`apps/ai/openapi.json`, `response-property-max/min-items-unset`).

Fix, exactly as directed: the Field constraints are back on `Shot`/`ShotPlan`/
`TargetPose` (the stored/returned, strict models) at their original values. Three new
models carry the *planner's own* output type instead — `TargetPoseDraft`, `ShotDraft`,
`ShotPlanDraft` (`apps/ai/app/schemas.py`) — each identical to its strict counterpart
except that `keypoints`/`steps`+`script`/`shots` carry no length `Field` at all (no
`minItems`/`maxItems` ever reaches Gemini, for any field, which is what Vertex needs).
`TargetPoseDraft` subclasses `TargetPose` (only its `keypoints` constraint changes, not
its type, so the override is sound); `ShotDraft` and `ShotPlanDraft` are **not**
subclasses of `Shot`/`ShotPlan` — basedpyright strict refuses overriding a mutable
field with a different *type* in a subclass (`reportIncompatibleVariableOverride`,
unsound covariance) for `pose: TargetPose → TargetPoseDraft` and
`shots: list[Shot] → list[ShotDraft]`, so those two are independent models that repeat
Shot's/ShotPlan's other fields. `repair_plan` now takes a `ShotPlanDraft` and returns a
real `ShotPlan`: every existing clamp/trim/sort step runs on the draft types unchanged
(they're structurally identical to the strict ones for everything `repair_plan` touches),
and the final step is `ShotPlan.model_validate(...)` over the repaired data — not
`model_copy` — so the real Field constraints run for the first time right there; a
trimming bug that still leaves something over the limit now raises `ValidationError`
loudly instead of writing an inconsistent plan.

Dropped entirely: the custom `_LenientGoogleJsonSchemaTransformer`, the `_INDEX_PROFILE`
model-profile override, and the `pydantic_ai._json_schema` private import — all
unnecessary now that the draft model simply never declares the bound pydantic-ai would
otherwise have to strip.

Reverted to match base `2752443` exactly (confirmed below): `packages/contracts/src/api/
director.ts`'s `shotPlanSchema.shots` has its `.min(1).max(DIRECTOR_MAX_SHOTS)` back;
`apps/api/src/modules/director/limits.test.ts`'s assertion is back to
`expect(...maxItems).toBe(DIRECTOR_MAX_SHOTS)`; `bun run gen` regenerated
`apps/ai/openapi.json`, `apps/api/openapi.json` and `packages/ai-client/src/generated/*`.

**Verified with the exact command CI's `api-compat` job runs** (`.github/workflows/
ci.yml`, `tufin/oasdiff:v1.32.1 breaking <base> <head> --fail-on ERR`), against base
`2752443`:
```
$ docker run --rm -v base:/base:ro -v apps/api:/head:ro tufin/oasdiff:v1.32.1 \
    breaking /base/api.json /head/openapi.json --fail-on ERR
No changes detected                                                    (exit 0)

$ docker run --rm -v base:/base:ro -v apps/ai:/head:ro tufin/oasdiff:v1.32.1 \
    breaking /base/ai.json /head/openapi.json --fail-on ERR
No breaking changes to report, but the specs are different.            (exit 0)
```
`oasdiff diff` on the ai service shows exactly one structural difference from base: the
`purpose` field's description text (intentionally tightened in this task, not a bound).
`apps/api/openapi.json` is byte-for-byte identical to base.

### IMPORTANT 2 — wrong model recorded for a plan

`Director.analyze` reserved the budget and stored the plan under `self._model_name`
(`DIRECTOR_MODEL`, the interactive model scene-checks and reviews use) even though a
plan is written by `INDEX_MODEL` or its fallback. Fixed: `_run_planner` now returns
`(result, answering_model)` — the name of whichever of `self._planner`/
`self._planner_fallback` actually answered — and `analyze` stores that as the plan's
`model`. The *reservation* (taken before either model has run, so it can't yet know
which will answer) is explicitly placed under `self._index_model_name` (the primary),
via a new optional `model=` parameter on `Director._reserve`.
`test_the_planner_retries_then_falls_back_to_the_index_fallback_model` now asserts
`plan.model == fallback_model` and, separately, that every `ai.usage` row for the
org's `director-plan` feature is still under the *primary* index model's name
(`usage_models(org, "director-plan") == {GEMINI_MODEL}`) — proving the two are no longer
conflated.

### IMPORTANT 3 — fall back (not retry) on an auth error or a non-video 403/404

`retryable()` already refused 401/403/404, so a "spurious auth error" was never going to
reach the fallback as the old comment claimed, and a 404 for an unrecognized or
unavailable model would just fail the plan outright with no fallback attempt either.
Took the preferred fix: a new `_falls_back_to_the_other_model(error)` returns `True` for
a 401 (always about the model, never the video) or a 403/404 whose body isn't about the
video (reusing the same word-list check `_refusal_code` already had, factored out into
`_about_the_video`). `_run_planner`'s loop checks this before the retryable check and
`break`s straight to the fallback call with no retry and no sleep; a 403/404 that *is*
about the video, or a plain 400, still raises immediately as before (a different model
watching the same unwatchable video wouldn't help). New test:
`test_a_refusal_about_the_model_falls_back_without_retrying` (a 404 "model not found"
style body) asserts exactly one call to the primary and one to the fallback, and
`plan.model == fallback_model`.

### IMPORTANT 4 — hard-coded English in the synthesized step

`_synthesized_step` no longer wraps the scene in `"Get ready: " + scene + "."` (English,
and a double period when the scene already ended in one): it uses `shot.scene` alone,
truncated to `ShotStep.instruction`'s 160 chars. The scene text is already in the short's
own language, so the synthesized step is too.

### Minor 6 — FPS comment

Both comments calling `INDEX_VIDEO_FPS` "one frame a second" now say "three frames a
second" (`youtube_video`'s docstring and the constant's own comment).

### Minor 9 — assert exactly one Gemini call

`test_a_video_gemini_may_not_watch_fails_without_retrying` now asserts
`len(gemini[0].received) == 1`, proving the video-specific 403 is neither retried nor
sent to the fallback.

### Minor 7 — trimming to MAX_SHOTS keeps the payoff

`plan_repair.py`'s new `_trim_shots` keeps the earliest `MAX_SHOTS - 1` shots plus the
last one, instead of a plain `[:MAX_SHOTS]` cut that would always drop the final shot —
the payoff the whole plan was building to. Test renamed to
`test_repair_trims_shots_to_the_director_max_but_keeps_the_last` and updated to assert
the kept set is `[0, 1, ..., MAX_SHOTS - 2, last]`, not `[0, 1, ..., MAX_SHOTS - 1]`.

### Tests added/changed this round

- `apps/ai/tests/test_plan_repair.py`: `plan()`/`shot()` build `ShotPlanDraft` now (the
  type `repair_plan` actually takes); the trim test renamed and its expectation updated
  for the keep-the-last behavior; the synthesized-step test tightened to assert the
  exact instruction text (no prefix). 12 tests, still 100% line+branch coverage of
  `plan_repair.py`.
- `apps/ai/tests/test_director.py`: new `usage_models()` helper (distinct models an
  `ai.usage` feature was recorded under); new `_client_with_index_fallback` context
  manager factoring out the custom-env `TestClient` setup the two model-attribution/
  fallback tests share; `test_a_video_gemini_may_not_watch_fails_without_retrying`
  asserts exactly one call; `test_the_planner_retries_then_falls_back_to_the_index_
  fallback_model` gained the `plan.model`/`usage_models` assertions; new
  `test_a_refusal_about_the_model_falls_back_without_retrying`. 32 tests.

### Commands and output (this round)

- `bun run --filter @repo/ai check-types`: `0 errors, 0 warnings, 0 notes`.
- `bun run --cwd apps/ai lint`: clean.
- `bun run --filter @repo/ai test:integration -- tests/test_director.py`: `32 passed`.
- `bun run --filter @repo/ai coverage`: `TOTAL 1842 0 238 0 100%`, `173 passed`.
- `bun run --filter @repo/api test`: `158 passed` (limits.test.ts reverted and green).
- `bun run --filter @repo/contracts test`: `32 passed`.
- `bun run lint` (repo-wide): all green.
- `bun run check-types` (repo-wide, runs `bun run gen`): all 28 tasks green;
  `apps/api/openapi.json` now byte-identical to base `2752443`; `apps/ai/openapi.json`
  differs from base only in the `purpose` description.
- oasdiff against base `2752443` for both services: zero errors, as shown above.

### Status contract

status: fixed, all five findings addressed, 100% coverage held, oasdiff clean against
base 2752443
branch: worktree-agent-a8d4560cf42b3765d (from feat/mm/director-hackathon)
commit range: none (left uncommitted, per instruction)
tests: apps/ai unit+integration 173 passed (test_director.py 32, test_plan_repair.py
12); apps/api 158 passed; apps/contracts 32 passed; repo-wide lint and check-types clean;
`bun run gen` drift-free against the new source; oasdiff `breaking --fail-on ERR` zero
errors for both apps/api and apps/ai against base 2752443
concerns: none
