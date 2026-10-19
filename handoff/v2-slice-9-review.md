# Review: Director v2 slice 9, server side (`origin/feat/mm/v2-assets`)

Reviewed at `7b0d732` (7 commits on merge base `ae43b93`). I only read; no checkout or branch
was changed. Line numbers are on the branch unless a merged tree is named.

What I ran myself:
- `oasdiff breaking` (CI's `tufin/oasdiff:v1.32.1` image), origin/master against the branch,
  for `apps/api/openapi.json` and `apps/ai/openapi.json`: "No breaking changes" for both.
- `python -m app.export_openapi` on an exported copy of the branch's `apps/ai`: matches the
  committed `apps/ai/openapi.json` byte for byte.
- The schema pydantic-ai would send Gemini for `ShotPlanDraft`, through
  `GoogleJsonSchemaTransformer`, for master and for the branch (numbers under check 2).
- `pytest tests/test_plan_repair_assets.py tests/test_assets_units.py`: 29 passed.
- `git merge-tree --write-tree` against `fd9ef09`, `origin/master` (`581ab3a`) and
  `origin/feat/mm/director-v2` (`655a6f4`).

## Verdict per check

| # | Check | Verdict |
|---|---|---|
| 1 | Backward compatibility | **Pass** |
| 2 | Planner schema against Vertex | **Risk, not proven**: no `minItems`/`maxItems`, but new constructs Vertex has never been sent from this repo, and the schema is 2.4 times bigger. Never run live. |
| 3 | The asset job | **Pass, with gaps**: idempotent, retries and ledger are right, keys and signing are tight. The daily limit is check-then-insert, not atomic (a member can't reach it today). |
| 4 | The migration | **Pass** |
| 5 | Prompt and repair | **Partial**: "recreate, never copy" is in the prompt and nothing downloads YouTube images, but the original's on-screen text, brand names included, goes into the image prompt word for word. |
| 6 | Tests and evals | **Pass, with gaps**: real behaviour through Postgres, Redis and `tests/fakes.py`. I couldn't confirm 100% coverage (needs the full suites). The evals count things and don't check what the spec's acceptance asks. |
| 7 | Merge conflicts | **Conflicts**: two files against master (fd9ef09 and 581ab3a alike), four against director-v2, and one semantic merge issue. |
| 8 | Commit messages | **Minor issues**: one `wip(ai)` commit, which commitlint's type list refuses, and one stale body. No AI mentions. |

### 1. Backward compatibility: pass
- Old plans: every new field has a default. `Shot.mode` defaults to `on-camera`
  (`apps/ai/app/schemas.py:182-186`), and `ShotPlan.assets` and `edits` default to empty
  lists (`schemas.py:475-476`). The contract matches with `.default(...)`
  (`packages/contracts/src/api/director.ts` shot `mode`, plan `assets` and `edits`).
- Committed seeds: the `director-seeds.json` diff only adds `"mode": "on-camera"` (35 times),
  `"assets": []` and `"edits": []` (6 times each). Nothing else changed.
- The API reads AI answers with old and new versions on either side. `wirePlan.assetImages`
  has `.default([])` (`apps/api/src/modules/director/director.service.ts:77-86`), and an old
  API's non-strict `z.object` drops the new fields.
- The "mode, not new kinds" decision (commit 8a0a05f) keeps `kind`'s enum unchanged. That
  is what keeps oasdiff clean. It differs from spec 7.2, so the owner should confirm it as a
  product decision.
- Generated files: `apps/ai/openapi.json` regenerates identically.
  `apps/ai/app/contracts/ai_director_assets_job.py` and `ai_director_job_name.py` match
  `packages/jobs/src/queues.ts:152-156`. I didn't regenerate `packages/ai-client/src/generated/*`
  or `apps/api/openapi.json`; the report says `bun run gen` showed no drift.

### 2. Planner schema against Vertex: risk
The repo's guard is `ShotPlanDraft`: no length bounds, with `repair_plan` restoring them
(`schemas.py:28-39`). There is one test, which checks that the request has no
`minItems`/`maxItems` (`apps/ai/tests/test_director.py:456-459`). The branch keeps that
rule: the draft has no array bounds, no `pattern` (the asset id pattern is only on `Asset`,
`schemas.py:311`), no `oneOf` and no discriminated union (`EditDraft` is flat,
`schemas.py:316-361`).

Here is what the transformed schema sent to Gemini contains:

| | master | branch |
|---|---|---|
| size (JSON characters) | 6,311 | 14,975 |
| `default` keywords | 0 | **24** |
| `anyOf` (nullable) | 1 | **25** |
| `$ref` | 10 | 31 |
| non-required properties | 0 | **24** (21 on `EditDraft`, plus `mode`, `assets`, `edits`) |

These constructs are new to this repo:
- **`default`** next to `$ref` and inside nullable fields: `ShotDraft.mode`
  (`schemas.py:500-504`), every `EditDraft` field (`schemas.py:325-361`), and
  `ShotPlanDraft.assets`/`edits` (`schemas.py:548-556`). No Gemini output schema on master
  has a `default` (SceneCheck, TakeReview, PublishCopyDraft and ShotPlanDraft all have 0),
  so Vertex has never accepted one from this code. pydantic-ai's transformer doesn't remove
  it.
- **`anyOf: [{$ref: Box}, {type: null}]`** (`EditDraft.box`, `schemas.py:335`) and nullable
  enums inside `anyOf`. Master only had `anyOf [string, null]`.
- **Many optional properties on one object** (`EditDraft`, 21 of them). This is the shape
  most likely to get Vertex's "schema produces a constraint that has too many states for
  serving" 400. That is a different keyword from the earlier bug, but the same failure:
  every indexing run fails.

The implementer says so in their own report: the schema "hasn't been sent live".

### 3. The asset job: pass, with gaps
- **Idempotency:** claims use `ON CONFLICT DO NOTHING` on the partial unique
  `(plan_id, asset_id) WHERE origin='default'` (`apps/ai/app/assets.py:235-243`, migration
  line 39). The job id is `"{plan_id}-assets"` (`director.py:703-717`). `make` only picks up
  `pending`/`generating` rows, so a second run draws nothing (`assets.py:256-262`), and a
  test covers that (`tests/test_assets.py`, "Again: nothing left to draw").
- **Retries:** 429s, 5xx and storage errors put the row back to `pending` and raise
  `AssetsInterrupted`. A refusal, an answer with no image, or the last attempt fail the row
  (`assets.py:295-301`, `167-174`). If the plan job is retried after the plan was saved, it
  re-queues pending images (`director.py:590-593`).
- **Ledger:** each image is reserved at `DIRECTOR_TOKENS_PER_ASSET`. A reservation smaller
  than one whole image is given back and the image fails `AI_BUDGET_EXCEEDED`
  (`assets.py:274-288`). Settlement is in `finally` with the real usage
  (`assets.py:302-303`). Tests check the exact `usage(org, "director-asset")`.
- **Limits:** at most 5 a plan (`assets.py:51`, `75`). 30 a day across workspaces is counted
  through `ai.images_today` (`assets.py:220-222`). That count is not atomic; see Minor 1.
- **Storage keys:** `director-assets/<planId>/<assetId>.<png|jpg>` (`assets.py:99-102`).
  The asset id is held to `^[a-z0-9]+(-[a-z0-9]+)*$` three times: by `repair_plan`, by
  `Asset`'s pattern, and by the DB CHECK (migration lines 52-54).
- **Signing:** `planAssetImages` signs only when `objectKey` is exactly
  `director-assets/${planId}/${assetId}.png|.jpg`, and serves anything else as failed
  (`apps/api/src/modules/director/asset-images.ts:26-38`). Seed images go through
  `directorSeedSchema`, which only allows `seed-media/<videoId>/asset-<id>.png|jpg` for an
  asset id the plan has (`packages/contracts/src/director-seeds.ts`, `expectedKeys`), plus
  the widened `director-seed-media.json` key pattern.

### 4. The migration: pass
- Expand-only: a new table, indexes and FKs, and nothing changed on existing tables. It has
  `lock_timeout = '5s'`, and the Squawk suppressions are explained (migration lines 1-8).
- RLS is `ENABLE` + `FORCE` with the standard `tenant_isolation` policy (lines 63-67).
  Grants are `SELECT, INSERT, UPDATE` to `app_ai` only, no DELETE (line 92).
- `ai.images_today` (lines 74-81) follows the repo's existing SECURITY DEFINER pattern
  (`20260929110000_digest_schedule`, `20260929090000_push_devices`):
  `SET search_path = pg_catalog, pg_temp`, a fully qualified table, the parameter qualified
  as `images_today.user_id` so it can't be confused with the column, `REVOKE ... FROM PUBLIC`,
  and `GRANT EXECUTE` only to `app_ai`. The owner bypass policy is narrower than the
  precedent: `FOR SELECT TO migrator` (line 86). The function returns only a count.
  `app_ai` can ask for any user's count, which is acceptable for the service's own role.

### 5. Prompt and repair: partial
- "Recreate, never copy" is in `PLAN_INSTRUCTIONS` (`director.py:161-169`: "Never copy the
  original's picture... a generic person... no logos, watermarks or brand names").
  `image_prompt` adds `_GENERIC_PERSON` and `_NO_MARKS` (`assets.py:64-67`, `78-90`).
- Nothing downloads YouTube images. Nano Banana gets a text-only prompt (`assets.py:142-151`).
  No new `httpx`, thumbnail or `ytimg` use (searched the diff).
- Repair (`apps/ai/app/plan_repair.py:277-479`) is careful. It slugs and dedupes ids, edits
  follow renames, timings are clamped into the Short, each edit type is made whole or
  dropped, and edits are sorted and trimmed. The result is validated against the real
  `ShotPlan`.
- Gap: see Important 2 (brand and headline text copied word for word).

### 6. Tests and evals: pass, with gaps
- `tests/test_assets.py` runs against real Postgres and Redis, with Gemini, Nano Banana and
  GCS stand-ins on one fake server (`tests/fakes.py:108-131` adds `gemini_image`). It
  covers claim limits across workspaces, drawing and storing, every failure path, the
  budget, tenancy (`asset_images` from another org returns `[]`), the worker routing and
  round-tripping a stored plan. `test_plan_repair_assets.py` covers each edit type, drops,
  renames, trims and old plans. The API side has `asset-images.test.ts` and
  `director.integration.test.ts`.
- 100% coverage: not verified here. A focused run covers only part of it, as expected
  without the integration suites. The report says 100% of `app/`, `scripts/` and `evals/`.
- Evals: see Minor 4.

### 7. Merge conflicts
- **fd9ef09 and origin/master 581ab3a** (the same result): conflicts in
  `apps/ai/app/director.py` (master's `_fail_plan(..., details: Target)` against the new
  `_queue_assets`/`make_assets`/`asset_images` inserted just before it) and
  `apps/ai/app/worker.py` (imports: `app.activity` against `AiDirectorAssetsJob`). Both
  are mechanical.
- **Semantic, after either merge:** master wraps each job in `run_job(job, final, ...)`,
  which writes the `job.finished` activity line. The branch's `assets` arm merges without a
  conflict but isn't wrapped (merged tree `25467f9`, `apps/ai/app/worker.py:109-112`). See
  Important 3.
- **origin/feat/mm/director-v2** (it contains fd9ef09): the same two conflicts, plus
  modify/delete on `apps/web/src/modules/director/lib/doodle.test.ts` and
  `apps/web/test/director/lib/doodle.test.tsx` (director-v2 deletes them, this branch adds
  `mode` to their fixtures; keep the deletion). `packages/contracts/src/api/director.ts`,
  `apps/web/test/director/support.tsx` and `apps/api/openapi.json` merge on their own.
  director-v2's new shot fixtures go through `planShot` (support.tsx), so `mode` reaches
  them. Run `check-types` on the merged tree anyway.

### 8. Commit messages
Every commit is Conventional with a workspace scope and has no AI or Claude mentions,
except as noted under Minor 5.

## Issues

### Critical
None.

### Important

**1. The planner schema has never reached Vertex, and adds constructs the repo has never
sent it.** `apps/ai/app/schemas.py:316-361` (`EditDraft`), `500-504` (`ShotDraft.mode`),
`548-556` (`ShotPlanDraft.assets`/`edits`).
- *What:* 24 `default` keywords, 25 nullable `anyOf` (one wrapping a `$ref`), 21 optional
  properties on one object, and a schema 2.4 times the size of master's. The only guard is
  the `minItems`/`maxItems` byte check (`tests/test_director.py:456-459`).
- *Why:* if Vertex answers 400 (on `default`, or "too many states"), every indexing run
  fails, both the primary and the fallback model. That is the same failure as the earlier
  `minItems` bug, and the tests can't see it because the fake Gemini accepts any schema.
- *Fix:*
  - Follow the repo's existing nullable convention (`sceneLandmark: str | None`, required,
    no default). Make every `EditDraft` field required-and-nullable with no `default`. Make
    `ShotDraft.mode` required. Make `ShotPlanDraft.assets`/`edits` required, without
    `default_factory`; `ShotPlan` keeps its defaults for stored plans.
  - Add a byte check that `"default"` isn't in the sent schema, next to the `minItems` one.
  - Before merging, run
    `bun run --filter @repo/ai evals:index -- --only OvRozQobeuI --only kM_NHn_MT3Q --only IFBBmwsGpUw --only b5G8cbgh7K0`.
  - If Vertex still refuses it as too complex, split edits into a few smaller per-type
    lists, or drop rarely used fields from the draft.

**2. The original's on-screen text, brand names included, goes into the default image
word for word.** `apps/ai/app/director.py:165` (reference text "word for word") with
`apps/ai/app/assets.py:89` (`The text "...", spelt exactly like that.`), against
`assets.py:67` (`No logos, watermarks or brand names anywhere.`).
- *What:* every line of `reference.text` is appended to the Nano Banana prompt as exact
  text, so the prompt both asks for no brand names and spells them out (b5G8cbgh7K0's
  school name and "Apply Now" end card, be10X's card).
- *Why:* spec 7.4 says "the school's logo and end card are their branding: the member's
  version gets their own name or none", and 7.1 says recreate, don't copy, the creator's
  work. Default images are drawn with no human in the loop and shown to every member.
- *Fix:* keep `reference.text` as the original's description, but don't feed it verbatim.
  Have the planner mark brand or channel text (or leave it out of `prompt`), and build the
  image prompt from `asset.prompt` plus style, palette and composition. Add a test that a
  brand line in `reference.text` doesn't reach the drawing request.

**3. After merging master, the `assets` job writes no `job.finished` activity line.**
Merged tree `25467f9`, `apps/ai/app/worker.py:109-112`.
- *What:* master's `run_job` wraps `plan` and `review-take`. The branch's `assets` arm
  auto-merges unwrapped, and its image outcomes log no activity
  (`director.indexed`/`take_reviewed`-style lines).
- *Why:* fd9ef09 made per-job activity lines the observability contract; Node workers and
  the other Python jobs all write them.
- *Fix:* when resolving the two conflicts, wrap
  `director.make_assets(...)` in `run_job(job, final, lambda: ...)`, and consider an
  activity line per image (ready/failed, with tokens). Then rerun the AI unit and
  integration suites on the merged tree.

### Minor

**1. The 30-a-day limit is check-then-insert, not atomic.** `apps/ai/app/assets.py:220-243`.
- Two concurrent claims for one member under READ COMMITTED can both read 28 and insert
  5 each.
- No member can reach this today: claims only happen when a user plan is saved, and
  `director_plan_one_user_index` allows one such plan per member across all workspaces.
  Slice 10's picker will reuse this path, though.
- *Fix:* take `pg_advisory_xact_lock(hashtextextended(user_id::text, 0))` in the claim
  transaction before calling `ai.images_today`, or do the count and insert in one
  SECURITY DEFINER function under that lock.

**2. An image row whose asset isn't in the stored plan crashes the job.**
`apps/ai/app/assets.py:269-270` (`assets[row.asset_id]` raises `KeyError`).
- It is reachable when `_save_plan` commits and then its `publish_to_org` raises on the
  final attempt (`director.py:610`, `617-623`): `_fail_plan` marks the now-saved plan
  failed. A retried index then writes a plan with different asset ids, and the stale rows
  raise on every attempt. Those images stay "making" forever and still count against the
  member's day.
- *Fix:* skip, or fail with a code, rows whose asset id isn't in the plan, and add a test
  for it.

**3. If queueing the assets job fails on the plan job's final attempt, images stay
`pending` with no job.** `director.py:627`.
- The UI shows "making" forever.
- *Fix:* tolerate it (log it and let a later read or another job re-queue), or mark the
  rows failed.

**4. The evals only count.** `apps/ai/evals/index_shorts.py` (`_missing`),
`apps/ai/evals/shorts.json`.
- Spec 7.5 asks that OvRozQobeuI's chart reference describe the title, twelve rows,
  portraits and palette. The eval only checks `stills >= 1`.
- b5G8cbgh7K0 doesn't expect `text` lower thirds.
- The evals haven't been run live (see Important 1).
- *Fix:* add `lowerThirds` and a minimal reference-content expectation (for example, the
  chart's `reference.text` contains "ARCHETYPES").

**5. Commit messages.**
- `bca1b60 wip(ai): ...` fails commitlint: `@commitlint/config-conventional` has no `wip`
  type.
- `f7c2b27`'s body describes "voice-over and asset shot kinds", which `8a0a05f` replaced
  with `mode`.
- *Fix:* squash on merge with a `feat(ai): ...` title (the report suggests this).

**6. Seeds haven't been filled in.**
- `seeds:assets` and `seeds:media` weren't run, so every seeded template has
  `assets: []`, and 7.5's acceptance can't be checked on seeds yet.
- Spec 7.2 said to re-index with `seeds:build`. Re-indexing only assets and edits is a
  reasonable change, but the owner has to run it and commit the result.

**7. Seed backfill can keep a stale image.** `apps/ai/scripts/seed_assets.py:55-59`.
- An image already drawn is kept whenever the new index reuses the asset id, even if that
  asset's reference or prompt changed.
- *Fix:* drop the key when the asset's prompt or reference changed.

**8. Images are signed for rows that won't be served.**
`apps/api/src/modules/director/director.service.ts:280-285`.
- Every ready row gets a signed link, including rows whose asset is no longer in the plan;
  `withAssetImages` then drops them.
- Harmless, but you could filter `images` by `shotPlan.assets` ids before signing.

## Verdict

**Needs fixes.**
- Important 1 blocks merging: remove `default` from the draft and run the four-Short eval
  live once, so we know Vertex accepts the schema.
- Fix Important 2, the brand text in default images, before images are drawn for members.
- Fix Important 3 when resolving the master/director-v2 conflicts.
- The rest (migration, signing, idempotency, ledger and compatibility) is solid.

---

## Re-review (fix round, tip `cf8909c`, rebased onto master `581ab3a`)

The fix round is three commits: `d8ecd05`, `632b184` and `cf8909c`. I read their diffs and
the engineer's fix-round section of the report.

What I ran myself:
- `tests/test_planner_schema.py` (integration-marked, fake Gemini only): 1 passed.
- Focused unit runs of `test_assets_units`, `test_plan_repair_assets`,
  `test_eval_index_shorts` and `test_seed_assets`: 63 passed.
- oasdiff for both OpenAPI documents against master: no breaking changes.
- `app.export_openapi` matches the committed `apps/ai/openapi.json` byte for byte.
- `git merge-tree` against master: clean. Against director-v2: only the two doodle-test
  modify/delete conflicts (keep director-v2's deletion).
- A probe of `app/branding.py` on ordinary text (results below).

### Verdict on each earlier issue

| Issue | Verdict |
|---|---|
| Important 1: planner schema | **Fixed.** |
| Important 2: branding in default images | **Fixed as asked, but the fix over-replaces** (new Important A). |
| Important 3: run_job and activity | **Fixed.** |
| Minor 1: daily limit not atomic | **Fixed.** |
| Minor 2: crash on an asset the plan no longer has | **Fixed** (one leftover, new Minor B). |
| Minor 3: images left pending if queueing fails | **Not done**, acknowledged. Still Minor. |
| Minor 4: evals only count | **Fixed** (one tolerance to align with the ruling, new Minor C). |
| Minor 5: commit messages | **Open.** `6498e86 wip(ai)` is still there. Squash on merge. The fix commits are Conventional, with no AI mentions. |
| Minor 6: seeds not backfilled | **Open, the owner's step.** |
| Minor 7: stale seed image | **Fixed.** |
| Minor 8: signing rows that aren't served | **Fixed.** |

**Important 1: fixed.**
- Every draft field is now required and nullable with no default (`schemas.py`
  `EditDraft`, `ShotDraft.mode`, `ShotPlanDraft.assets`/`edits`).
- The box is four numbers, and the edits' enums are plain aliases, so they inline.
- The sent schema has 0 `default`, no `minItems`/`maxItems`/`pattern`, and every `anyOf`
  is `[scalar, null]`.
- The test's guarantees are strong. `tests/test_planner_schema.py` reads the request
  actually sent through the fake, so it follows pydantic-ai's real transformation. It
  checks:
  - every schema node uses only master's 13 keywords;
  - there is no `default`;
  - every `anyOf` is exactly a scalar or null (no `$ref` inside);
  - every property is required.
- It fails loudly if the output mode ever changes, because it unpacks the
  `final_result` declaration.
- What it can't guarantee is Vertex's "too many states" limit. The schema is still about
  14.6k characters against master's 6.3k. The report's live runs on gemini-4-argon (six
  runs, about 17 Short-indexes) are the evidence for that, and they're accepted.

**Important 2: fixed as asked, but the fix over-replaces.**
- Brands, handles and web addresses are kept out of the Nano Banana prompt
  (`assets.py:80-93`) and out of edit words (`plan_repair.py:411`). The stored
  `reference.text` keeps the original word for word.
- The over-replacement is new Important A.

**Important 3: fixed.**
- The `assets` job runs through `run_job` (`worker.py:106-117`), so it writes
  `job.finished`. The `lambda` captures `assets` correctly.
- Every image writes `director.asset_drawn`: ok, failed, or refused (from
  `outcome_of(code)`), with tokens, for the member it counts against (`assets.py`
  `_fail` and `_target`).
- `director.asset_drawn` is in `packages/contracts/src/activity.ts` ACTIVITIES and the
  generated `activity_line` schema and model.

**Minor 1: fixed.**
- `pg_advisory_xact_lock(hashtextextended('ai.director-images:<userId>', 0))` runs in the
  `_save_plan` transaction before `ai.images_today` (`assets.py:229-237`).
- The scope is right:
  - The lock is per member, across workspaces, because the key is the user id and not
    the org.
  - It lasts until that transaction commits.
  - Under READ COMMITTED, the waiter's next statement sees the committed rows.
  - Its namespace is distinct from the `index` and `usage` advisory keys, and none of
    them is held while waiting on this one, so there's no deadlock.
- `images_lock_key` is exported for slice 10's picker to reuse.

**Minor 2: fixed.**
- An image whose asset is no longer in the plan is failed with `VALIDATION_FAILED` and
  logged, instead of raising `KeyError`.
- A plan that isn't ready is skipped (`assets.py:269-296`).
- The leftover is new Minor B.

**Minor 4: fixed.**
- The evals now check the split layout, still text ("archetype", "crore", "2026"), the
  caption style, captions between the halves, voice-only shots, lower thirds, gaps and
  the end card.
- The split tolerance needs aligning with the ruling: new Minor C.

**Minor 7: fixed.** `seed_assets.py` keeps an image only when `image_prompt` and the
aspect ratio are unchanged.

**Minor 8: fixed.** `director.service.ts` filters by the plan's asset ids before
signing.

### New issues the fixes introduced

**Important A. Brand replacement matches inside words, re-matches its own
placeholders, and removes topic names.** `apps/ai/app/branding.py:27-35`, used at
`assets.py:87-93` and `plan_repair.py:411`.

*What:* brand names are matched as bare substrings (no word boundaries), after the
handle and website placeholders have been put in. Probing the branch's `unbranding`:

| Brands | Input | Output |
|---|---|---|
| `["AI"]` | "Maintain your AI training plan" | "MYour NamentYour Namen your Your Name trYour Namening plan" |
| `["Apple"]` | "Pineapple smoothie" | "PineYour Name smoothie" |
| `["Mesa"]` | "Mesaverde" | "Your Nameverde" |
| `["X"]` | "Max out 10X" | "MaYour Name out 10Your Name" |
| `["Name"]` | "@mesaschool" | "@yourYour Name" (the placeholder matched again) |
| `["Claude"]` | "Mastering Claude in 2026" | "Mastering Your Name in 2026" |

- The prompt asks for every "brand, product or company name"
  (`director.py:173`). So a product that is the Short's own topic, like IFBB's "Claude",
  becomes "Your Name".
- The website pattern also catches ordinary text: "e.g.in 2 steps" becomes
  "yourwebsite.com 2 steps".
- In edits it applies plan-wide: one asset's brands rewrite every text edit's words.

*Why:*
- This runs at index time, and the result is stored in the plan, so the damage lasts.
- A two-letter brand such as "AI" is likely on exactly the owner's example Shorts (be10X,
  Claude), and it would corrupt every caption, title, label and default-image text that
  contains those letters.
- The tests only cover whole-word brands ("be10X", "Mesa School"), so none of this is
  caught.

*Fix:*
- Match brands as whole words: `(?<![\w])name(?![\w])`.
- Do the three replacements in one `re.sub` pass over a combined pattern, so a
  placeholder is never matched again.
- Narrow `brands` to the original's own identity (the creator, channel, company, school,
  their handles and sites), not products discussed as the topic. Say so in the prompt
  and in the `brands` field description.
- Tighten the website pattern: no match after a one-letter label such as "e.g.", or
  require a scheme, `www.`, or a label of at least two letters.
- Add tests for each probe above.

**Minor B. A re-queued assets job can be swallowed for a day.** `director.py:763`.
- The job id is the fixed `"{plan_id}-assets"`, and completed `ai-director` jobs are
  kept for `removeOnComplete: { age: DAY_S }`.
- `_jobs` now completes without drawing anything for a plan that isn't ready. On the rare
  save-then-fail path, a retried index's new claims are re-queued under the same id, and
  BullMQ ignores the add for 24 hours. Those images stay "making".
- The plan job already avoids this with `"{plan.id}-{_stamp(plan.updated_at)}"`
  (`director.py:532`).
- *Fix:* stamp the assets job id the same way.

**Minor C. The split tolerance doesn't match the ruling.**
`apps/ai/evals/index_shorts.py:200-203`, `apps/ai/app/director.py:194`.
- The ruling: the editor uses Gemini's measured share and snaps to halves within ±8% of
  50/50.
- The eval's `halves` check allows ±0.05.
- The prompt tells Gemini to answer 0.5 "whenever the two parts look about the same
  size", which hides the measured share the editor is supposed to snap from.
- *Fix:* ask for the measured share in the prompt, and widen the eval to ±0.08. Dropping
  `halves` from OvRozQobeuI's expectation, at about 0.35, fits the ruling.

### Re-review verdict

**Needs fixes.** Important A must be fixed before merge, because the corruption is
stored. Minors B and C are small and can go in the same change. Everything else from the
first review is resolved or accepted.
