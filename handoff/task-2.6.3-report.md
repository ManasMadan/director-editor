# Task 2.6.3 report: seed media (Nano Banana storyboards, Veo previews, Lyria music)

Status: DONE_WITH_CONCERNS
Worktree branch: `worktree-agent-ace7fc26dda425245`, based on `origin/feat/mm/director-hackathon` (1d603ad)
Commits: `1d603ad..cebb32a` (6 commits)

(This report is in the worktree, because the guard refused the shared-checkout path.)

```
cebb32a test(api): expect a seeded template's media links in a new member's library
df2d7cb feat(contracts): give the 6 seed templates their storyboard cards, previews and music
75518b4 fix(ai): renew seed media's gcloud token before each call and on a 401
77005b4 fix(ai): keep seed media's model clients open and wait out spent quotas
e4aeccd feat(ai): make the seeds' storyboard cards, previews and music on Vertex AI
1e19a2c feat(api): link a seed's storyboard cards, previews and music in its plan
```

## What was generated (run for real, all 6 seeds)

Everything is in `gs://director-media-1053522546520/seed-media/<videoId>/`, and every key is
recorded in `packages/contracts/src/director-seeds.json`:

| Medium | Model (Vertex AI) | Count | Format |
|---|---|---|---|
| Storyboard card per shot | `gemini-nano-banana-2.1` (global) | 35 / 35 | PNG, 9:16, 1K (768x1376) |
| Preview clip per shot | `veo-3.1-lite-generate-001` (us-central1) | 35 / 35 (cap 40) | MP4, 720x1280, silent, 4 s (shots of 5 s or less) or 6 s; 156 s in all |
| Music per seed | `lyria-3-clip-preview` (global) | 6 / 6 | MP3 (`audio/mpeg`, about 27-30 s), so the keys are `music.mp3` |

76 objects, 142.8 MB. A final `--dry-run` reports 0 left to make. I looked at samples: the
storyboard cards are clean pencil sketches with no text, and the clips show a generic
person (for example a woman in a market for the head-nod intro, not the creator).

I checked each model on Vertex first with a one-off call (scratch scripts, gcloud user
token). The publisher-model resources confirmed `gemini-nano-banana-2.1` GA,
`veo-3.1-lite-generate-001` public preview and `lyria-3-clip-preview` public preview.
`lyria-002` also exists (WAV); I chose Lyria 3 Clip as the current one. Lyria 3 on Vertex
needs `response_modalities=["AUDIO","TEXT"]`; asking for audio alone gets a 400.

Cost estimate, from the script's constants (Vertex list prices as I found them on
2026-10-18): 35 x $0.04 images + 156 s x $0.03/s silent 720p video + 6 x $0.04 tracks =
**about $6.32**. If silent Veo Lite is billed at the with-audio rate ($0.05/s), it's about
$9.44. On top of that come the probes: 2 images, one 4 s clip and 1 track. Veo clips its
filters held back aren't billed (Google says so in the refusal).

It took three runs. The script is resumable, so each run picked up what was still missing:
1. 20 previews made. The rest failed for three reasons:
   - google-genai closed the image client's connections. Only `client.aio.models` was
     held, so the `Client` was garbage-collected and its `__del__` closed the shared httpx
     client.
   - Veo answered 429 (`long_running_online_prediction_requests_per_base_model`).
   - Veo's safety filter held back 2 clips.
2. I fixed the first two (hold the client; wait out 429s with backoff). This run made 24
   more, then the gcloud token expired mid-run and the rest got 401.
3. I fixed the token: it's asked of gcloud again before each call and upload, and once
   more on a 401. This run made the remaining 32 with 0 failures. That includes the clip
   that had been filtered (22k0fZarxh8 shot 2), which passed on a retry with the same
   prompt.

## What changed and why

### Plan schema: optional media keys (Python and zod)
- `apps/ai/app/schemas.py`: `Shot.storyboardKey`, `Shot.previewKey` and `ShotPlan.musicKey`
  are optional, `max_length=200`, with `exclude_if=None`. A plan without them dumps with
  no such fields at all (not nulls), so every stored plan, user plan and the seed file
  read exactly as before. The planner's output type is `ShotPlanDraft`, which has no
  such fields, so Gemini can never write a key.
- `packages/contracts/src/api/director.ts`: the same three fields as `.optional()` on
  `shotSchema`/`shotPlanSchema`. The existing "same plan, field for field" test in
  `apps/api/src/modules/director/limits.test.ts` failed first, then passed.
- Decision on "musicKey per seed": I put it on the plan (`ShotPlan.musicKey`) rather
  than on `SeedTemplate` next to `audioKey`. On the plan it travels with the copy into
  `ai.director_plan.plan` (JSON), so it needs no migration or new column, and the API
  reads it back from the row the same way as the shot keys.

### API: signed links, seed rows only (`apps/api/src/modules/director/director.service.ts`)
- The served plan is a new contract shape (`servedShotPlanSchema`, type `ServedShotPlan`).
  Each shot has optional `storyboardUrl`/`previewUrl`, the plan has an optional
  `musicUrl`, and the keys themselves are left out (like `audioKey`).
  `directorPlanSchema.plan` now uses it. This only adds optional fields to `/api/v1`
  (openapi.json regenerated), and the web types still check.
- `toPlan` parses the AI service's row with the stored `shotPlanSchema`, then swaps each
  key for `FilesService.objectUrl(key, 1 hour)`, **only when `source === "seed"`**. A
  member's plan never has keys. If one ever carries them, they are dropped and not
  signed, so nothing a row says can become a link to another object (tested). With
  uploads off, `objectUrl` is null and the field is left out.
- This applies everywhere a `DirectorPlan` is served (library, plan, index).

### seeds:build keeps media (`apps/ai/scripts/build_seeds.py`)
- `keep_media(templates, previous)`: re-running `seeds:build` keeps the media keys of a
  seed whose plan came out exactly the same (content compared with the keys left out).
  It drops them for a seed whose plan changed, because media drawn from the old shots
  would show the wrong scenes. `main` now reads the existing file (`load_templates`)
  first.
- The order is documented in both scripts and in `apps/ai/CLAUDE.md`: `seeds:build`,
  then `seeds:media`.
- Old objects of a changed seed stay in the bucket. The next `seeds:media` overwrites
  them, since the keys are the same.

### The script: `apps/ai/scripts/seed_media.py`
Command: `bun run --filter @repo/ai seeds:media -- --bucket <bucket> [--dry-run] [--concurrency N]`

- **Shot prompts** come only from a shot's own directions: `scene`, `framing.shotSize`
  and `framing.note`, `pose.description`, `purpose`, the `camera` (front/rear),
  `phoneAngle.height`, and the steps' `cameraMove` enums. They never use titles, step
  text, script lines or the plan summary, which can name a brand (tested with a
  "Brandname" fixture). Every prompt says anyone in it is a generic adult, not a likeness
  of any real person, and asks for no text or logos. Veo also gets a negative prompt for
  text and logos.
- **Music prompt**: the format, the duration, every shot's purpose in order (the moods),
  and a pace and BPM hint from the seconds per cut (fast at 3 s or less, steady up to
  8 s, slow beyond). Instrumental only.
- **Resumable and idempotent**: it only makes media that has no key yet, and saves the
  seed file after each one lands. Veo is capped at 40 clips, counting those already made,
  and it logs how many it held back.
- **Before making anything** it logs the counts, the preview seconds and the estimated
  cost. `--dry-run` stops there and logs every prompt. It exits 1 if anything failed, so
  you know to run it again.
- **Auth**: the signed-in gcloud account (`gcloud auth print-access-token`, run with
  `asyncio.create_subprocess_exec`). This Mac has no ADC
  (`gcloud auth application-default print-access-token` fails), but the owner's gcloud
  user token works.
- **Settings**: it honours `GOOGLE_BASE_URL` (the tests point it at the stand-in) and
  reads `GOOGLE_CLOUD_PROJECT` and `VERTEX_LOCATION` from the existing settings. There are
  no new env vars. The bucket is a required flag, not hard-coded.
- I didn't use the express-mode API key at all (the brief allowed ADC or user
  credentials for this offline script), and I didn't test whether the key reaches Veo or
  Lyria.

### Tests

`apps/ai/tests/test_seed_media.py` (35 tests), with the media models injected:
- prompt building, preview length and pace
- which jobs it makes, what it skips, the Veo cap, the cost estimate
- the run writing each key and saving after each one
- a failed medium leaving its key unset
- the music file extension taken from the type Lyria answered with
- the dry run (connects to nothing, leaves the file untouched) and the command's exit code
- the gcloud token, and its renewal on a 401
- the GCS upload, with the client stood in by monkeypatch as `test_audio.py` does

The same file runs the real google-genai client against a local stand-in for Vertex's
media endpoints, added to `tests/fakes.py` (`vertex_inline`, `veo_started`, `veo_polls`,
`VEO_FILTERED` and others):
- the request bodies (9:16, 1K, AUDIO+TEXT, 720p, silent, 4 s)
- Veo polling, a failed Veo operation and a filtered clip
- a 429 waited out and retried, a quota still spent after 5 tries failing, and any other
  refusal failing at once
- the client staying alive across `gc.collect()`
- `python -m scripts.seed_media --dry-run` as a subprocess against the committed file

Other test files:
- `apps/ai/tests/test_build_seeds.py`: the keys are optional and left out when unset;
  `keep_media` keeps or drops; `load_templates`; `main` keeps the media of an unchanged
  plan.
- `packages/contracts/src/director-seeds.test.ts`: the zod parse keeps the media keys,
  leaves them absent when absent, and refuses an empty one.
- `packages/contracts/src/api/director.test.ts` (new): the served plan keeps the URLs,
  drops the keys and refuses non-URLs.
- `apps/api/test/director.integration.test.ts`:
  - a seed plan with keys gets signed URLs (`X-Amz-Expires=3600`) for its music,
    storyboards and previews, from both `library` and `plan`
  - a seed plan without keys gets none, and neither does a member's plan carrying keys
  - keys are never served
- `apps/api/test/director-without-storage.integration.test.ts`: with uploads off, no links.
- `apps/api/test/director-seeds.integration.test.ts` (end to end, through the real copy
  into the database): a new member's 6 seeds come back with signed links to every
  committed storyboard, preview and track.

### Docs
- `apps/ai/CLAUDE.md`: the `seeds:media` command.
- `apps/ai/package.json`: the `seeds:media` script.
- `docs/testing.md`: the two google-cloud-storage pyright ignores in `seed_media.py`,
  the same as those in `app/audio.py`.

## TDD evidence (failing first)
- Python: `pytest tests/test_build_seeds.py` failed at collection (no `keep_media` or
  `load_templates`) before the code existed. `tests/test_seed_media.py` failed at
  collection before the script existed.
- `limits.test.ts` "describe the same plan, field for field" failed: the three new
  Python fields were missing from the contract. `director.test.ts` and
  `director-seeds.test.ts` failed 3 tests before the zod changes.
- `director.integration.test.ts` "links a seeded template's storyboard cards..." failed
  (`TypeError: Invalid URL`, no `musicUrl`) before the service change.
- Each bug found in the real runs got a failing test first:
  - the GC test failed with `RuntimeError: Cannot send a request, as the client has been
    closed.` before the client was held
  - the 429 tests failed (`connect_vertex() got an unexpected keyword argument
    'retry_seconds'`) before the retry
  - the 401 and token tests failed on import (`GcloudToken`) before the renewal

## Checks (tails)

```
$ bun run lint
  ✔ bunx biome check .        ✔ bun run lint:boundaries   ✔ bun run lint:unused
  ✔ bun run lint:markers      ✔ bun run lint:patterns     ✔ bun run lint:suppressions
  ✔ bun run lint:prisma ... ✔ bunx turbo run lint   (ruff, ruff format, deptry: no issues)

$ bun run check-types
 Tasks:    24 successful, 24 total        (@repo/ai check-types: 0 errors, 0 warnings, 0 notes)

$ bun run type-coverage        -> every workspace ✔

$ bun run test
 Tasks:    22 successful, 22 total

$ bun run --filter @repo/ai coverage     (unit + integration, stack 3)
 scripts/build_seeds.py   70  0   6  0   100%
 scripts/seed_media.py   239  0  56  0   100%
 TOTAL                  1625  0 236  0   100%
 Required test coverage of 100.0% reached. Total coverage: 100.00%
 ================== 195 passed, 3 warnings in 79.03s ==================

$ bun run --filter @repo/api test:integration     (stack 3)
 Test Files  10 passed (10)
      Tests  109 passed | 13 skipped (122)

$ bun run --filter @repo/contracts test
      Tests  39 passed (39)

$ bun run --filter @repo/api coverage && bun scripts/coverage.ts
 apps/api/src/modules/director/* and packages/contracts/src/api/director.ts: not listed (100%).
 (The 8 failures in that run are the `files`-tagged upload suite. It needs RustFS, which
 isn't in the core stack: "TypeError: fetch failed ... ECONNREFUSED". Unrelated to this
 change. The merged report lists many other files because only these suites ran.)

$ bun run gen   -> no drift (git status clean)
```

I didn't touch `scripts/` or the hooks, so I didn't run `bun test ./scripts/ ./.claude/hooks/`.
My stack is down (`bun run db:down`).

## Concerns
1. **Workspaces seeded before this change won't show media.** The API reads keys from
   each workspace's copy of the plan, and copies made before this commit have no keys.
   The API can only insert seed rows, not update them, and `seed-workspaces` skips
   workspaces that already have the seed. So any workspace that exists before deploy
   needs its seed rows refreshed. That means the owner's local workspaces, and
   production if seeds were already backfilled there.
   - Options: a one-off SQL update of `ai.director_plan.plan` for `source='seed'` rows
     from the committed file, or a refresh path in the AI service.
   - Another design I considered and didn't build: the API looks up a seed row's media in
     the bundled seed file by video id. That fixes old copies, but it ties serving to the
     file.
2. **Signing cost per library read.** Each library read now signs about 76 more URLs (35
   storyboards, 35 previews, 6 tracks) on top of the 6 audio links. On GCS with the VM's
   service account, each signature is an IAM signBlob call, made in parallel. That's
   fine for a demo, but cache the links or sign media only in `plan()` if library
   latency matters.
3. **Vertex quotas are tight.** Veo Lite's long-running request quota and Nano Banana's
   shared quota both returned 429 at concurrency 2-3. The script waits them out, but a
   full run took about 40 minutes across three runs.
4. **The cost estimate rests on unconfirmed prices.** I took them from search results:
   Veo Lite silent 720p at $0.03/s, Nano Banana 1K at about $0.04 including thinking
   tokens, Lyria 3 Clip at $0.04. Check them against the billing report.
5. **Two of the models are public preview** (`veo-3.1-lite-generate-001` and
   `lyria-3-clip-preview`). They're only used offline, so the app doesn't depend on them.
6. **Web wiring isn't done** (per the dispatch). The template page can use
   `plan.plan.shots[i].storyboardUrl` / `previewUrl` and `plan.plan.musicUrl`
   (`ServedShotPlan` from `@repo/contracts/api`).

## Fix round 1

Status: DONE_WITH_CONCERNS. I rebased onto `origin/feat/mm/director-hackathon`; the
branch is now `9d08a47..9eb9371`, with the original 6 commits rebased (the only
conflicts were the service header and `schemas.py` constants, and I kept both sides).
The fix commits on top are:

```
9eb9371 refactor(api): build a seed's media links from pure helpers
0952b6c fix(api): link a seed's media only on its own page, from the committed seed
1f4162b refactor(contracts): keep each seed's media beside its plan, checked key by key
```

I didn't regenerate any media. I moved the keys already in `director-seeds.json` onto
each seed's `media` with a one-off transform, then validated the file with zod (the
contracts tests, and the API's start-up parse) and with Pydantic (`test_seeds_templates.py`).

### RULING, item by item

**The keys move off ShotPlan onto the seed entry.**
- Contract: the seed entry has `media: { music?, shots: [{ storyboard?, preview? }] }`
  (`packages/contracts/src/director-seeds.ts:33-62`). `ShotPlan` and `Shot` have no key
  fields again (`packages/contracts/src/api/director.ts`). `apps/ai/app/schemas.py` is
  back to upstream exactly, and the openapi/ai-client regeneration dropped the fields.
- Python: `SeedMedia`, `SeedShotMedia` and `SeedTemplate.media` are in
  `apps/ai/scripts/build_seeds.py:91-152`.
- seeds:build: `keep_media` (`build_seeds.py:205`) copies the `media` of a seed whose
  plan is unchanged and drops it for one whose plan changed.
- seeds:media: writes there (`seed_media.py` `_media_of` and `_make`).
- Tests:
  - `director-seeds.test.ts` "each carry their media..." (the plan names no
    `seed-media/` path)
  - `director.test.ts` "names no storage path in a plan"
  - `test_build_seeds.py::test_a_plan_names_no_storage_path`,
    `test_a_seed_s_media_is_left_out_of_its_json_until_it_has_some` and the
    `test_keep_media_*` tests
  - `test_seed_media.py::test_each_medium_is_uploaded_and_its_key_written_as_it_lands`
    (the plan is untouched, and the keys land in `media`)

**The API builds links from the bundled seeds, by videoId, for seed rows only, and only
when the shot count matches.**
- `apps/api/src/modules/director/seed-media.ts`: `seedMediaKeys(videoId, shotCount)`
  reads the bundled `directorSeeds`, never the row. `withMediaLinks` puts the signed
  links in place.
- The service checks `source === "seed"` and that media was asked for, at
  `director.service.ts` `toPlan` (`withSeedMedia`, lines 250-263).
- Existing workspaces get media with no migration.
- Tests:
  - `seed-media.test.ts`: the seed's keys, a non-seed, a shot-count mismatch (±1), a seed
    with no media or only some, and links left out when null.
  - `director.integration.test.ts` "links a seeded template's media on its own page, from
    the committed seed only": a seed row whose stored plan has `files/<uuid>/take.webm`
    planted in every key field gets the committed seed's links, and nothing in the
    response contains `files/` or a `*Key` field.
  - `director.integration.test.ts` "links no media for any other plan, whatever its stored
    plan names": a non-seed with planted keys, a seed's Short with a 1-shot plan, and a
    member's own index of a seed all get no links.

**Validate every key.**
- zod: the shared rule is in `packages/contracts/src/director-seed-media.json`
  (`^seed-media/[A-Za-z0-9_-]{11}/(shot-(\d{1,2})\.(png|jpg|mp4)|music\.(mp3|wav))$`,
  max length 200). On top of that, a `superRefine` (`director-seeds.ts:64`) requires the
  seed's own folder, the shot's position (`shot-<index>`), the right kind per field
  (storyboard png/jpg, preview mp4, music mp3/wav), and one `media.shots` entry per plan
  shot. All of this is parsed at module load, so a bad file stops the API at start-up.
- Python: the same rule file (`MEDIA_RULES`, `build_seeds.py:75`) constrains every key
  field, and `_media_is_this_seed_s` (`build_seeds.py:142`) makes the same seed, shot and
  kind check. seeds:build and seeds:media fail early.
- Tests:
  - `director-seeds.test.ts` "refuse a media key anywhere but its own seed, shot and kind"
    (a foreign path, another seed, the wrong kind, the wrong shot, `../`, the wrong shot
    count, an extra field)
  - `test_build_seeds.py::test_a_seed_refuses_a_media_key_anywhere_but_its_own_seed_shot_and_kind`
    (10 parametrized cases)
  - the integration test with the planted foreign key, above

**Sign media only in `director.plan`.**
- `toPlan(row, { media })` (`director.service.ts`).
- `library()` (line 109) and `index()` (line 117) pass `media: false`.
- `plan()` (line 121, the router's `director.plan`) passes `media: true`. A new `planOf()`
  (line 126) passes `media: false` and serves `shots()` and the live call
  (`apps/api/src/server.ts:71,80`, `Pick<DirectorService, "planOf">`).
- The `MEDIA_READ_EXPIRES_S` comment (line 58) is updated.
- Tests:
  - `server.test.ts` "asks the director service for the caller's plan in their workspace,
    without its media" (`planOf`)
  - `director.integration.test.ts`: the library has no `*Url` fields, and `director.plan`
    does
  - `director-seeds.integration.test.ts`:
    - "are in a new member's library...": no media URLs in the library
    - "each link their storyboard cards, previews and music on their own page": for each
      of the 6 committed seeds through the real copy, the stand-in AI now answers
      `getPlan` from the database
  - `director-without-storage.integration.test.ts`: with uploads off, `director.plan` of a
    real seed has no links

### Minor items

**4. `director.py:796`** is moot: the take reviewer's prompt dumps the whole `Shot`
(`director.py:763`, `shot.model_dump_json()`), and `Shot` no longer has any storage
field. Test: `test_a_plan_names_no_storage_path` (asserts `Shot.model_fields` has no key
fields).

**5. The cap counts billed clips.** `Ledger` (`seed_media.py:550`) is committed at
`apps/ai/scripts/seed-media-ledger.json`.
- `_make` records a clip the moment Veo answers with it (`billed(job)`, line 285), before
  the upload.
- `media_jobs(templates, billed=ledger.count())` caps at `MAX_PREVIEWS - billed` (line
  239).
- I seeded the ledger with the 35 clips already made (156 s). My one 4 s probe clip
  isn't on it.
- Tests:
  - `test_previews_stop_at_the_cap_counting_every_clip_ever_billed`
  - `test_a_clip_is_on_the_ledger_even_when_its_upload_fails`
  - `test_the_ledger_records_each_billed_clip_and_reads_back`
  - `test_the_committed_ledger_counts_every_clip_already_made`
  - `test_the_command_makes_no_clip_once_the_ledger_is_at_the_cap`
  - `test_the_command_makes_what_s_missing_into_the_bucket_it_names` (the ledger grows by
    2)

**6. `--concurrency` is bounded to 1..8** (`_concurrency`, `seed_media.py:577`;
`MAX_CONCURRENCY = 8`). Tests: `test_the_command_refuses_arguments_it_can_t_run_with`
(0, 9 and "many" are refused) and `test_the_command_runs_one_to_eight_at_a_time`.

**7. `--bucket` is required only without `--dry-run`** (`parser.error`,
`seed_media.py:596`). Tests: `test_a_dry_run_says_what_it_would_make_and_makes_nothing`
(runs with no `--bucket`, and writes no ledger) and the `[]` case of
`test_the_command_refuses_arguments_it_can_t_run_with`.

**8. Parity of the media key rules.**
- With the keys off ShotPlan they're no longer in the AI service's OpenAPI document, so
  `limits.test.ts` can't compare them through `@repo/ai-client`. Instead, both sides read
  the same rule file, `packages/contracts/src/director-seed-media.json`, and each side has
  a test that its schema carries that pattern and max length:
  - `director-seeds.test.ts` "check every media key against the rule the AI service's
    scripts check it with" (the zod JSON Schema)
  - `test_build_seeds.py::test_media_keys_follow_the_rule_the_contract_checks_them_with`
    (Pydantic's JSON schema)
- `limits.test.ts` still pins ShotPlan parity, and with the keys removed on both sides it
  passes unchanged.

**9. `apps/ai/CLAUDE.md`** now says `--bucket` must be the bucket the API serves files
from (production's GCS bucket), and that locally the API reads RustFS, where those keys
404. It also says `--dry-run` needs no bucket and that the ledger is committed. The
`seed_media.py` docstring says the same.

### TDD evidence (round 1)
- contracts: the new `director-seeds.test.ts`/`director.test.ts` failed first ("the first
  seed's media is missing"; "expected ... not to contain 'files/'").
- Python: `test_build_seeds.py` failed at collection before `SeedMedia`/`MEDIA_RULES_PATH`
  existed. After one test fixture was fixed, `test_seed_media.py` failed on the
  `Ledger` import before the ledger existed.
- API unit: `seed-media.test.ts` failed (`Cannot find module './seed-media'`), and
  `server.test.ts` failed (`deps.director.plan is not a function`), before the code.
- API integration: with the new tests and the old service temporarily restored, 4 tests
  failed: the two new media tests, plus two live-call tests, because the old service has
  no `planOf`. All 28 pass with the new service.

### Checks (round 1, stack 3)
```
$ bun run lint                      -> 0 ✖ (biome, boundaries, knip, patterns, suppressions, turbo lint: ruff/deptry)
$ bun run check-types               -> Tasks: 24 successful, 24 total
$ bun run type-coverage             -> every workspace ✔
$ bun run test                      -> Tasks: 22 successful, 22 total
                                       (@repo/api 207 passed, @repo/contracts 43 passed)
$ bun run --filter @repo/ai coverage
  scripts/build_seeds.py     96  0  14  0  100%
  scripts/seed_media.py     267  0  60  0  100%
  TOTAL                    2066  0 304  0  100%
  Required test coverage of 100.0% reached.  287 passed
$ bun run --filter @repo/api test:integration -- director*.integration.test.ts
  Tests  28 passed | 3 skipped (31)
$ bun run --filter @repo/api test:integration      (all core suites)
  Tests  2 failed | 134 passed | 16 skipped (152)
  FAIL api.integration.test.ts > account deletion > removes the personal workspace and its data
  FAIL api.integration.test.ts > account deletion > won't leave a shared workspace without an owner, ...
    (expected { plans: 1 }, got { plans: 7 }: the 6 seed copies upstream's sign-up adds.
     These are upstream's own, and this branch doesn't change the test, seeds.repository or auth.)
$ bun run --filter @repo/api coverage && bun scripts/coverage.ts
  apps/api/src/modules/director/seed-media.ts, packages/contracts/src/director-seeds.ts,
  packages/contracts/src/api/director.ts: 100%.
  director.service.ts: only line 154 (upstream's speak()) is missed, because that run
  includes the `files` suites, which need RustFS (ECONNREFUSED :59300) and Director's
  voice, all down in my stack. All new media code is covered.
$ bun run gen                        -> no drift
```
My stack is down (`bun run db:down`).

### Concerns (round 1)
- The 2 account-deletion failures above come from upstream (the seed copies are counted
  in `plans`). This branch doesn't cause them, but they're red on the integration branch.
- A seed whose plan is rebuilt with the same shot count would show new media on older
  copies. The ruling chose the shot-count check, and seeds:build plus seeds:media
  regenerate media for any changed seed, so the window is only between those two
  commands.
- `generate_videos(prompt=...)` logs a google-genai DeprecationWarning (use `source=`). It
  still works, and it's untouched since media isn't being regenerated.
