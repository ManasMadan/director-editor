# Task 2.1.2 / 2.1.4 report: plan repair and audio capture

Worktree: `/Users/manas.madan/Desktop/code/director-editor/.claude/worktrees/agent-a8d4560cf42b3765d`
Branch: `worktree-agent-a8d4560cf42b3765d` (checked out from `feat/mm/director-hackathon`)

Note: `.superpowers/` isn't tracked by git and didn't exist in this worktree, so this
report was written here (the worktree's own copy) rather than the shared checkout's
path the brief named; the Write tool refuses cross-worktree writes. Copy it over, or
read it from here.

## Files touched

- `apps/ai/app/plan_repair.py` (new) — `repair_plan`
- `apps/ai/tests/test_plan_repair.py` (new) — 8 unit tests
- `apps/ai/app/audio.py` (new) — `fetch_audio`, `run_yt_dlp`, `upload_to_gcs`
- `apps/ai/tests/test_audio.py` (new) — 5 unit tests
- `apps/ai/app/director.py` — `analyze` now calls `repair_plan(result.output, None)` just
  before saving the plan (video length isn't known: Gemini watches the short by URL, it's
  never downloaded here)
- `deploy/docker/ai.Dockerfile` — adds `ffmpeg` (apt) and `yt-dlp` (pip, pinned, with a
  `# renovate: datasource=pypi depName=yt-dlp` comment), before pip is removed
- `apps/ai/pyproject.toml` / `apps/ai/uv.lock` — `google-cloud-storage` added via `uv add`
- `docs/testing.md` — two new rows in the Suppressions table (see below)

## Design notes

- `repair_plan(plan, video_seconds)`: sorts shots by `sourceStartSeconds`, clamps each
  shot's source range into `[0, video_seconds]` (or `[0, MAX_SHORT_SECONDS]` when
  `video_seconds` is `None`), trims overlaps so one shot's end never passes the next
  one's start, drops shots whose resulting source span is under 0.3s (keeping the
  longest one instead if that would empty the plan — `ShotPlan.shots` needs at least
  one), clamps each remaining shot's `durationSeconds` to `[0.5, MAX_SHOT_SECONDS]`,
  clamps its script lines and steps into that duration (dropping script lines that
  clamp to nothing), and recomputes `ShotPlan.durationSeconds` as the sum.
  `Shot.durationSeconds`'s own Field already enforces `[0.5, MAX_SHOT_SECONDS]`, so that
  particular clamp is defensive/always a no-op today; kept because the brief asks for it
  and it costs nothing.
- `fetch_audio(video_id, bucket, *, run=run_yt_dlp, upload=upload_to_gcs)`: runs yt-dlp
  via `asyncio.create_subprocess_exec` (no shell), extracts m4a into a temp dir, and
  uploads to `gs://{bucket}/audio/{video_id}.m4a` with `google-cloud-storage`'s default
  client (Application Default Credentials, no key file). Both the runner and the
  uploader are injectable; any failure (non-zero exit, upload exception) is logged and
  answered with `None`, never raised. Not called from anywhere yet, as specified.
- `google-cloud-storage` ships no type stubs, so `basedpyright` (strict) flags the
  import and the upload chain; I added `# pyright: ignore[reportMissingTypeStubs]` and
  `# pyright: ignore[reportUnknownMemberType]` and listed both in docs/testing.md's
  Suppressions table (matches the existing rows for langgraph/bullmq/redis-py).
- `ffmpeg`'s apt version isn't pinned (`# hadolint ignore=DL3008`, also added to the
  Suppressions table): trixie's mirror doesn't keep old package versions, so a hard pin
  would go stale and fail the build instead of catching anything real.

## TDD evidence

### plan_repair.py

RED (module didn't exist):
```
$ uv run pytest tests/test_plan_repair.py -q
ModuleNotFoundError: No module named 'app.plan_repair'
```
GREEN after writing `app/plan_repair.py`:
```
$ uv run pytest tests/test_plan_repair.py -q
........                                                                 [100%]
8 passed in 0.04s
```
Coverage of the new module alone:
```
$ uv run pytest tests/test_plan_repair.py -q --cov=app.plan_repair --cov-branch --cov-report=term-missing
Name                 Stmts   Miss Branch BrPart  Cover   Missing
----------------------------------------------------------------
app/plan_repair.py      44      0     10      0   100%
```

Tests: `test_repair_sorts_and_removes_overlaps`, `test_repair_clamps_script_into_shot`,
`test_repair_keeps_a_valid_plan_unchanged`, `test_repair_drops_slivers_but_keeps_one_shot`
(the four named in the brief), plus `test_repair_clamps_source_ranges_into_the_video`,
`test_repair_without_a_video_length_clamps_to_the_short_s_own_limit`,
`test_repair_clamps_a_step_into_its_shot`, `test_repair_recomputes_the_plan_s_duration`
(added for 100% branch coverage of the whole function, not just the four named cases).

### audio.py

Wrote `fetch_audio`, `run_yt_dlp`, `upload_to_gcs` and `tests/test_audio.py` together;
first run failed on missing coverage of the two default implementations (82%, since the
brief's two named tests only exercise `fetch_audio` through fakes):
```
$ uv run pytest tests/test_audio.py -q --cov=app.audio --cov-branch --cov-report=term-missing
app/audio.py      32      6      2      0    82%   27-33, 40, 44-45
FAIL Required test coverage of 100.0% not reached. Total coverage: 82.35%
```
Added a test that runs `run_yt_dlp` against a harmless real subprocess
(`sys.executable -c ...`, no network, no yt-dlp binary needed) and a test that
monkeypatches `google.cloud.storage.Client` with a fake bucket/blob to exercise
`upload_to_gcs`'s real body without touching a real bucket. After that:
```
$ uv run pytest tests/test_audio.py -q --cov=app.audio --cov-branch --cov-report=term-missing
.....                                                                    [100%]
app/audio.py      32      0      2      0   100%
5 passed in 0.54s
```
Tests: `test_fetch_audio_uploads_and_returns_the_object_key`,
`test_fetch_audio_returns_none_when_yt_dlp_exits_non_zero` (the two named in the brief),
plus `test_fetch_audio_returns_none_when_the_upload_fails`,
`test_run_yt_dlp_runs_a_real_subprocess_and_reports_its_exit`,
`test_upload_to_gcs_uploads_through_the_bucket_and_blob`.

## Commands and output

- `uv run --project apps/ai ruff check apps/ai` / `ruff format --check apps/ai`: clean.
- `bun run --cwd apps/ai lint`: `uv run ruff check . && ruff format --check . && deptry .`
  all pass (deptry confirms `google-cloud-storage` is used, no unused/missing deps).
- `bun run --filter @repo/ai check-types`: `0 errors, 0 warnings, 0 notes`.
- `bun run --cwd apps/ai test`: `93 passed, 69 deselected` (unit suite).
- `bun run --filter @repo/ai test:integration -- tests/test_director.py`: `28 passed`
  (confirms `repair_plan` wired into `analyze` doesn't break any existing Director flow).
- `bun run --filter @repo/ai coverage` (unit + integration merged): every file in
  `app/` and `evals/` at 100%, including the two new modules and `director.py`
  (`TOTAL 1766 0 222 0 100%`). One pre-existing, unrelated failure the first time I ran
  it in this fresh worktree (`test_bullmq_pair.py`, because `node_modules` wasn't
  installed yet — `bun install` fixed it, confirmed by rerunning the whole unit suite
  clean afterward; nothing to do with this change).
- `bun run lint` (repo-wide): all green, including `lint:hadolint`, `lint:suppressions`,
  `lint:renovate`, `lint:boundaries`. One pre-existing, unrelated warning in
  `scripts/image-scan.test.ts` (a template-curly lint note), not something I touched.
- `bun run check-types` (repo-wide, regenerates `apps/ai/openapi.json` and
  `packages/ai-client` as part of its dependency graph): all green;
  `git status` shows no diff in either generated artifact, confirming this change
  doesn't touch the Director HTTP contract.
- `bun test scripts/dockerfiles.test.ts`: 8 pass (digest pinning still holds).

## Known gaps / judgment calls

- `repair_plan`'s `durationSeconds` clamp is unreachable in practice (the schema already
  bounds it); kept per the brief, harmless, and doesn't need a dedicated test since
  there's no branch to miss.
- `fetch_audio` isn't called from anywhere (per the brief — a later task wires it into
  indexing).
- Didn't add a GCS bucket setting to `app/settings.py`: `fetch_audio` takes `bucket` as a
  parameter, per the brief's signature, and there's no caller yet to need one.

## Commit

Not committed yet — holding for explicit approval per my global git-operations rule
(commits, pushes and PRs always need a specific go-ahead). Ready to commit with
`git commit --no-verify`, Conventional Commits, scope `ai`, e.g.
`feat(ai): repair inconsistent shot plans and add Director's audio capture`.

Update: the controller committed this work as `d1a0171` (plan repair) and `1af7c00`
(audio capture) on this worktree's branch.

## Fix round 1 (review findings in apps/ai/app/audio.py)

Two findings from the task review, both in `fetch_audio`:

1. **Critical** — `code, stderr = await run(args)` wasn't guarded. A runner that raises
   (yt-dlp missing, not executable, or any other `OSError`/exception starting the
   process) would propagate straight out of `fetch_audio`, breaking its "any failure →
   logged, `None`" contract — the one thing this whole module promises.
2. **Important** — `video_id` was used unvalidated in the temp file path (`-o` argument
   to yt-dlp) and the GCS key. Nothing stopped a malformed id (a path-traversal-shaped
   string, or one that's simply the wrong length) from reaching either.

### Fix

- Wrapped `await run(args)` in the same `try/except Exception: log.exception(...);
  return None` shape already used around `upload` — one failure contract, not two.
- Added a guard at the top of `fetch_audio`: `video_id` is checked against the existing
  `VIDEO_ID_PATTERN` (`^[A-Za-z0-9_-]{11}$`, from `app/schemas.py`, already used
  elsewhere for the same purpose — not a new pattern) with `re.fullmatch`; on a
  mismatch it logs and returns `None` before anything touches a path or a key, so the
  runner is never even called for a bad id.

### Tests added (apps/ai/tests/test_audio.py)

- `test_fetch_audio_returns_none_when_the_runner_raises` — a `run` that raises
  `FileNotFoundError`; asserts `None` and that `upload` is never called.
- `test_fetch_audio_refuses_a_malformed_video_id` — parametrized over `"../evil/xyz"`
  (wrong characters) and `"short"` (wrong length); asserts `None` and that neither
  `run` nor `upload` is ever called (both fail the test if invoked).

Confirmed both are real regression tests, not tautologies: ran them against the
previously-committed `1af7c00` version of `audio.py` (via `git show 1af7c00:...` into
the file, then restored the fixed version from a backup copy) — all three new test
cases failed there (the runner's `FileNotFoundError` propagated out of `fetch_audio`
in one; `run`/`upload` were both called with the malformed id in the other two), then
passed again once the fixed file was restored.

### Commands and output

```
$ bun run --cwd apps/ai test -- tests/test_audio.py
tests/test_audio.py ........                                             [100%]
8 passed in 0.36s
```
(8 tests now: the original 5 plus the 3 new ones above.)
```
$ uv run pytest tests/test_audio.py -q --cov=app.audio --cov-branch --cov-report=term-missing
Name           Stmts   Miss Branch BrPart  Cover   Missing
----------------------------------------------------------
app/audio.py      41      0      4      0   100%
Required test coverage of 100.0% reached. Total coverage: 100.00%
```
```
$ bun run --cwd apps/ai lint
uv run ruff check . && uv run ruff format --check . && uv run deptry .
All checks passed!
70 files already formatted
Success! No dependency issues found.
```
```
$ bun run --filter @repo/ai check-types
@repo/ai check-types: 0 errors, 0 warnings, 0 notes
```
```
$ bun run --cwd apps/ai test           # full unit suite
96 passed, 69 deselected
```
```
$ bun run --filter @repo/ai test:integration -- tests/test_director.py
tests/test_director.py ............................                      [100%]
28 passed
```
```
$ bun scripts/suppressions.ts          # no new suppressions introduced
(exit 0, no output)
```

`git status --short`: only `apps/ai/app/audio.py` and `apps/ai/tests/test_audio.py`
modified, left **uncommitted** as instructed (the controller commits).

### Status contract

status: fixed, both findings addressed, 100% coverage held
branch: worktree-agent-a8d4560cf42b3765d (from feat/mm/director-hackathon)
commit range: none (uncommitted, per instruction — prior commits d1a0171, 1af7c00 are the controller's)
tests: apps/ai/tests/test_audio.py now 8 tests, all passing; full apps/ai unit suite 96 passed; test_director.py integration 28 passed; lint and check-types clean
concerns: none
