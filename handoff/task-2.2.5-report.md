# Task 2.2.5 report: build the 6 seed templates

Note: `.superpowers/` doesn't exist in this worktree (the edit guard refused writing to
the shared-checkout path), so this report is written at the same relative path inside
the worktree instead, as instructed.

## What changed and why

Task 2.1.5 (`index_short`) didn't exist yet, so I built the minimal piece of it this
task needed, directly in `apps/ai/app/director.py`, and reused it from a new script.

**`apps/ai/app/director.py`** (refactor, no behavior change):
- Pulled the planner-agent construction (prompt, model settings, `defer_model_check`)
  out of `Director.__init__` into a new public `create_planner_agent(model) -> Agent[None,
  ShotPlanDraft]`, built once from a new module-level `PLANNER_SETTINGS` constant (what
  used to be a local variable in `__init__`).
- Pulled `Director._run_planner`'s retry-then-fallback loop, plus the `repair_plan` call
  `Director.analyze` used to make separately right after it, into a new public
  `index_short(planner, planner_name, planner_fallback, fallback_name, video_id, usage,
  usage_limits) -> tuple[ShotPlan, str]`. This is "index one Short into a repaired
  ShotPlan," in one place, with the real doc comment moved onto it. `Director._run_planner`
  is gone; `Director.analyze` now calls `index_short` directly with its own `self._planner`
  / `self._planner_fallback` and model names.
- Removed the now-unused `AgentRunResult` import.

This is a pure refactor: every existing `apps/ai/tests/test_director.py` integration
test (including the retry/fallback ones) passes unchanged, and `app/director.py` stays
at 100% line and branch coverage.

**`apps/ai/scripts/build_seeds.py`** (new): reads `app/seeds/seeds.json`, calls
`index_short` once per seed (its own pair of planner agents built through
`create_index_model`/`create_planner_agent` from `INDEX_MODEL`/`INDEX_FALLBACK_MODEL`,
and its own `RunUsage`/`UsageLimits` rather than a workspace's reservation — this script
runs outside any workspace), and writes
`[{videoId, plan, model, audioKey}]` to `app/seeds/templates.json`. `audioKey` is
`f"seed-audio/{video_id}.m4a"` (the brief's own convention; the audio itself is already
in `gs://director-media-1053522546520` under that key, uploaded separately — this script
never touches audio). Indexes seeds one at a time, in `seeds.json`'s own order, and lets
a seed that can't be indexed at all (retries and fallback both exhausted) blow up the
whole run rather than write a `templates.json` missing one of the 6.

A gotcha not in the brief: running `python apps/ai/scripts/build_seeds.py` (as the given
command does) puts the script's own directory on `sys.path`, not `apps/ai` — and
`apps/ai` isn't an installed package (`pyproject.toml`'s `package = false`), so `import
app.*` fails without a `sys.path` fix. I added one, written as an `if` (not a plain
assignment) ahead of the `app.*` imports so ruff's `E402` doesn't flag them — a real fix,
not a `# noqa` (the repo's suppressions checker refuses any `# noqa` without a
`docs/testing.md` row, and I didn't want to add one for something avoidable). Verified
empirically: `python apps/ai/scripts/build_seeds.py` without the fix raises
`ModuleNotFoundError: No module named 'app'`.

**`apps/ai/pyproject.toml`**: added `scripts` to basedpyright's `include` and
`executionEnvironments` (it wasn't checked at all before), since the coding standards
require strict typing everywhere, not just `app/` and `tests/`.

**Tests**:
- `apps/ai/tests/test_build_seeds.py` (new): pure unit tests of the script's non-network
  logic with the Gemini call injected (`audio_key`, `load_seeds` against the real
  `seeds.json` and against a malformed video id, `build_entry`, `build_templates`
  including a seed whose indexing fails propagating the error, `write_templates`
  round-tripping through JSON with a trailing newline, and `SeedTemplate`/`ShotPlan`'s
  own `shots` min-length-1 validation).
- `apps/ai/tests/test_seeds_templates.py` (new): validates the **committed**
  `templates.json` — every entry parses as a real `SeedTemplate` (so its `plan` validates
  against the real `ShotPlan`), the 6 `videoId`s match `seeds.json` exactly, and every
  plan has at least one shot.
- `apps/ai/pyproject.toml`'s `[tool.coverage.run]` only measures `app/`, so
  `scripts/build_seeds.py` doesn't count toward apps/ai's 100%; I tested it anyway (both
  files above), per the brief.

**`apps/ai/app/seeds/templates.json`** (new, committed): built by actually running
`bun --env-file=.env run uv run --project apps/ai python apps/ai/scripts/build_seeds.py`
against Vertex AI. All 6 seeds indexed on the **first attempt** with `gemini-4-argon` —
no 500s, no fallback needed for any of them:

| videoId | model | shots |
|---|---|---|
| 22k0fZarxh8 | gemini-4-argon | 10 |
| 152Jy2c3XSM | gemini-4-argon | 11 |
| _HonL1arbaA | gemini-4-argon | 6 |
| WvGUjw7OwZo | gemini-4-argon | 6 |
| 8OLAi6Eba98 | gemini-4-argon | 1 |
| vUZWe5kAsSM | gemini-4-argon | 1 |

Formatted with `bunx biome format --write apps/ai/app/seeds/templates.json` (the
script's own `json.dumps(indent=2)` output already matched Biome's formatting; no fixes
applied).

## TDD evidence

- `apps/ai/tests/test_build_seeds.py` written first; failed on collection
  (`ModuleNotFoundError: No module named 'scripts.build_seeds'`) before `build_seeds.py`
  existed, then passed (9 passed) once it did.
- `apps/ai/tests/test_seeds_templates.py` written first; failed
  (`FileNotFoundError: ... templates.json`) before the real indexing run, then passed
  once `templates.json` was committed.
- The `director.py` refactor is behavior-preserving (no new test needed for it beyond
  the existing suite, which already covers the retry/fallback/repair path): confirmed by
  re-running the full `test_director.py` integration suite unchanged and green.

## Commits

`5ffd8d4` — `feat(ai): index the 6 seed shorts for real and commit their templates`
(one commit; branch `worktree-agent-a26d85d324511cc56`, based on
`origin/feat/mm/director-hackathon`).

## Checks run (tail of output)

- `bun run --filter @repo/ai check-types` → `0 errors, 0 warnings, 0 notes`
- `uv run --project apps/ai ruff check apps/ai/scripts apps/ai/tests/test_build_seeds.py` → `All checks passed!`
- `bun run --filter @repo/ai lint` → ruff + ruff format + deptry all clean
- `uv run --project apps/ai pytest apps/ai/tests/test_build_seeds.py apps/ai/tests/test_seeds_templates.py -q` → `10 passed`
- `bun run --filter @repo/ai test` → `81 passed, 45 deselected`
- `bun run --filter @repo/ai test:integration` → `45 passed` (includes every
  `test_director.py` case, retry/fallback ones included, and the worker-process test)
- `bun run --filter @repo/ai coverage` (unit + integration merged) → `app/director.py`
  **100%** lines and branches. Overall apps/ai total is 99.68% because of a **pre-existing**
  gap in `app/telemetry.py` (lines 44-45, branch 56->62: the "real OTLP exporter, no
  processor given" and "no FastAPI app" paths, never exercised by any test) — confirmed
  pre-existing by temporarily removing every file this task added (keeping only the
  `director.py` refactor) and re-running coverage: identical 94% on `telemetry.py`,
  identical 99.68% total. I didn't touch `telemetry.py` or its tests and this is outside
  this task's scope, so I left it as is rather than scope-creep a fix into this change.
- `bun run lint` (full repo) → clean (one pre-existing, unrelated Biome warning in
  `scripts/image-scan.test.ts`)
- `bun run check-types` (full repo) → clean, `bun run gen` stayed drift-free
  (`openapi.json`/generated client regenerated identically)
- `bun test ./scripts/ ./.claude/hooks/` → `972 pass, 0 fail`

## Decisions the brief didn't make for me

- Where `index_short` lives and what it takes: a module-level function in
  `director.py` taking already-built `Agent` instances and model names (not `Settings`),
  so `Director` and the script each build their own pair the same way
  (`create_index_model` + `create_planner_agent`) and pass them in. This kept the
  `director.py` diff to exactly the extraction the brief asked for.
- `SeedSource`/`SeedTemplate` as small Pydantic models local to the script (not added to
  `app/schemas.py`): they're not part of the AI service's API contract (nothing in
  `apps/api` reads them directly; task 2.2.2 will read `templates.json` from the
  TypeScript side), so they didn't belong in the contract file.
- Indexing seeds sequentially, not concurrently: only 6, each already retries/falls back
  internally, and sequential keeps a re-run's diff and its Vertex AI quota usage
  predictable.
- Added `scripts` to basedpyright's `include`/`executionEnvironments` in
  `apps/ai/pyproject.toml` rather than leaving the new script untyped, since the repo's
  coding standards call for strict typing on every Python file.

## Status

DONE

**Commit range:** `69a4e46..5ffd8d4` (one commit, `5ffd8d4`)

**Test summary:** `apps/ai` unit 81 passed / integration 45 passed / new script tests
10 passed; full repo `bun run lint`, `bun run check-types`, `bun run test`, and
`bun test ./scripts/ ./.claude/hooks/` all green; `app/director.py` at 100% coverage.

**Concerns:**
- `app/telemetry.py` has a pre-existing 94% coverage gap (two real-exporter/no-app
  branches never exercised by any test), unrelated to this task and present before my
  change — flagged for whoever owns that file next, not fixed here.
- `docs/README.md`/`docs/environment.md` weren't touched: no new environment variable,
  skill, or runbook was added, just a one-off build script the brief already documents
  how to re-run.
