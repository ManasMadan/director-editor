## Verdict: Needs fixes

The functional spec is met. Two problems block approval:
- **CI contract gate:** dropping the list bounds from the *response* models breaks the repo's own `api-compat` check. I ran oasdiff and it reports 16 errors.
- **Wrong model recorded:** plans and token usage are still attributed to `DIRECTOR_MODEL`, not the model that actually wrote the plan.

### Spec Compliance
- ✅ **No `minItems`/`maxItems` in the schema sent to Gemini.** I checked pydantic-ai's walker: `transform()` runs on every node, and `walk()` also runs `_handle` on every `$defs` entry, so nested defs are covered too. The profile is only on the two index models; scout and reviewer don't get it. Neither `SceneCheck` nor `TakeReview` has an array, so they're unaffected. The wire test asserts no bounds reach the request.
- ✅ **`repair_plan` enforces every removed bound:**
  - shots trimmed to ≤ `MAX_SHOTS`
  - steps ≤ 10, script ≤ 20, keypoints ≤ 13
  - a step is synthesized when a shot has none
  - a plan with no shots raises `ValueError`, which ends up as `DIRECTOR_ANALYSIS_FAILED` (`repair_plan` now sits inside the `try`)
- ✅ **Contract kept consistent.** `shotPlanSchema` lost `.min/.max`, `limits.test.ts` was updated, and the generated output covers exactly the bound removals plus the `purpose` description.
- ✅ **Models.** `INDEX_MODEL` (`gemini-4-argon`) and `INDEX_FALLBACK_MODEL` (`gemini-3.1-pro-preview`) are in `settings.py` with aliases, in `.env.example` and in `docs/environment.md`. Scout and reviewer still use `DIRECTOR_MODEL`.
- ✅ **Retry and fallback.** 3 attempts on the primary for 5xx/429/transport/timeout errors, with 1s then 2s backoff, then one fallback call. Refusals and broken contracts raise immediately. One `RunUsage`/`UsageLimits` is shared across all attempts and settled once in `finally`, so retries are not double-charged. If the fallback fails with a retryable error, it goes to the job's BullMQ retry (3 job attempts), each of which reserves its own budget.
- ✅ **Video settings.** `media_type="video/*"`, `videoMetadata.fps=3.0` and `MEDIA_RESOLUTION_MEDIUM` all reach the request, and the test asserts it.
- ✅ **Prompt** covers every case in the brief: no person, no speech, on-screen text and doodles, cuts under 0.5s, slideshows, merging when over 12 shots, and `purpose` as role plus feeling. The `purpose` description was tightened.
- ✅ The no-person and no-speech tests run through the fake Gemini.
- ⚠️ **Live run on 3 seeds** is only in the report. It can't be reproduced and the script isn't committed.
- ❌ **Not mergeable through CI as-is** (Critical 1).

### Strengths
- It's a single source of truth: the limits moved into `repair_plan` with constants in `schemas.py`, and the prompt still states them as prose.
- The retry test is a real regression test: it gives the fallback its own path and asserts exactly `PLANNER_RETRIES + 1` primary calls and 1 fallback call.
- Token accounting across retries is correct (one reservation and cumulative limits).
- Generated files were regenerated, not edited by hand. The new suppression is documented in `docs/testing.md`.

### Issues

**Critical**

1. **The `api-compat` CI job and the pre-push hook will fail.**
   - **Where:** `apps/ai/app/schemas.py:148,196,199,211`, `packages/contracts/src/api/director.ts` (`shots`), and both `openapi.json` files.
   - **What:** I ran `tufin/oasdiff:v1.32.1 breaking --fail-on ERR` (the CI image) on base 2752443 vs head f887a14.
     - `apps/api/openapi.json`: 4 errors, `response-property-max-items-unset` and `response-property-min-items-unset` on `GET` and `POST /director/{videoId}/plan` `shots`.
     - `apps/ai/openapi.json`: 12 errors, the same rules on `shots`, `steps`, `script` and `pose.keypoints`.
     - Both rules are level `error`, so the job fails unless the title is marked breaking (`fix(ai)!:`), which would wrongly cut a major release.
     - It also breaks the python rule "Constrain every field" for response models: the OpenAPI document no longer states invariants the service still guarantees.
   - **Why it happened:** only the schema sent to Gemini needs to lose the bounds. The response contract doesn't.
   - **Fix:**
     - Give the planner a lenient output model with no list bounds (for example a `ShotPlanDraft` / `ShotDraft` / `TargetPoseDraft` mirror, or the strict models' fields minus the bounds) as its `output_type`.
     - Have `repair_plan(draft) -> ShotPlan` return the strict model, with its `min_length`/`max_length` restored, so a trim bug fails loudly.
     - Revert the contract, `limits.test.ts` and the regenerated files to keep the bounds.
     - The custom transformer is then unnecessary and can go, along with its private `pydantic_ai._json_schema` import.
     - Keep the wire assertion `b"minItems" not in sent`.

**Important**

2. **Wrong model attributed for plans and plan usage.**
   - **Where:** `apps/ai/app/director.py:459` (`model=self._model_name`) and `:693` (`_reserve` passes `self._model_name`).
   - **What:** plans are written by `INDEX_MODEL`, or by the fallback, but `director_plan.model` and the `ai_usage.model` rows record `DIRECTOR_MODEL`. The response's `model` field is now wrong, and per-model cost tracking puts Argon/Pro tokens under Flash. The test only passes because all three env vars are the same `GEMINI_MODEL`.
   - **Fix:** have `_run_planner` return which model answered (for example `(result, model_name)`), reserve under the index model name, and store the answering model. Add assertions in the fallback test that `plan.model == fallback_model` and that the usage row's model is right.

3. **A comment promises retries the code doesn't do.**
   - **Where:** `apps/ai/app/director.py:327`.
   - **What:** the comment says INDEX_MODEL fails intermittently with "a 500 or a spurious auth error" that a retry fixes. But `retryable()` returns False for 401/403, so a spurious auth error gets neither a retry nor the fallback. Likewise, a 404 for an unknown or unavailable model (`REFUSED_STATUSES`, line 73) never reaches the fallback, though that is exactly when a fallback model helps.
   - **Fix:** decide which you want. Either let the planner treat 401 (and a 404/403 whose body isn't about the video) as worth the fallback and test it, or correct the comment.

4. **The synthesized step is hard-coded English.**
   - **Where:** `apps/ai/app/plan_repair.py:40,144`.
   - **What:** `"Get ready: "` lands in a plan whose fields must all be "in the language the short is in". This user-facing string doesn't go through i18n and is read aloud. It also gives a double period when the scene already ends with ".".
   - **Fix:** use `shot.scene[:160]` alone, which is already in the short's language, or a language-neutral instruction.

**Minor**

5. **The transformer is untested and its docstring is unclear** (`director.py:184-192`). Nothing it would strip exists, so the wire test passes without it and coverage only touches the `pop` lines. The docstring's last sentence is garbled, and `JsonSchema` comes from the private `pydantic_ai._json_schema`. This is moot if Critical 1 is fixed as suggested. Otherwise add a unit test that feeds it a schema with bounds.

6. **FPS comments contradict the code** (`director.py:80,234`). Both say "a frame a second", but `INDEX_VIDEO_FPS = 3.0`.

7. **Trimming to 12 shots drops the ending** (`plan_repair.py:67`). `[:MAX_SHOTS]` keeps the earliest shots and drops the payoff. Consider merging the shortest adjacent same-kind shots instead, or at least note it as a last resort.

8. **Empty answers no longer get a corrective model retry.** Before, `min_length=1` on `shots` and `steps` made pydantic-ai send Gemini a corrective retry; now an empty `shots` list fails at once. Acceptable, but a deliberate trade-off.

9. **Refusal test doesn't assert the call count** (`tests/test_director.py:440`). `test_a_video_gemini_may_not_watch_fails_without_retrying` never asserts `len(gemini[0].received) == 1`, so retrying or falling back on a refusal would go unnoticed.

10. **Fallback test duplicates the `client` fixture.** It copies `conftest.client` word for word, which is why it needs the new suppression. The backoff also adds about 3s to each of the five 5xx tests; making the backoff injectable or monkeypatchable would avoid both.

### Checklist (verified clean)
- Types: signatures annotated, no `cast`/`Any`, and the one new ignore names its rule and is listed.
- Async: `asyncio.sleep`, each call has a 120s timeout, no blocking I/O.
- Tenancy and auth: unchanged, `tenant(org_id)` comes from the job.
- Errors: existing codes only, and exception text isn't leaked to the client.
- Settings: aliases, `.env.example` and `docs/environment.md` are in place; production checks unaffected; the fake Google accepts any model path.
- Budgets: reserve and settle happen once per run, with limits cumulative across retries (but see Important 2 on attribution).
- Generated code: regenerated, not hand-edited.
- Tests: pure tests in `test_plan_repair.py`, integration ones marked. I didn't re-run the suites, as instructed; the only command I ran was oasdiff.

### Assessment
**Task quality: Needs fixes.** The behaviour matches the brief and the dispatch decisions, and the Gemini-bound schema is clean. But widening the response contract fails CI's `api-compat` gate (16 oasdiff errors) when only the request schema needed changing. Plans and their token usage also record the wrong model. Fix Critical 1 with a lenient draft model for parsing Gemini's answer and a strict `ShotPlan` for what's stored and served, then fix Important 2–4.

Files: `.../agent-a8d4560cf42b3765d/apps/ai/app/director.py`, `.../apps/ai/app/plan_repair.py`, `.../apps/ai/app/schemas.py`, `.../packages/contracts/src/api/director.ts`, `.../apps/api/src/modules/director/limits.test.ts`, `.../apps/ai/tests/test_director.py`. All are under `/Users/manas.madan/Desktop/code/director-editor/.claude/worktrees/`.
