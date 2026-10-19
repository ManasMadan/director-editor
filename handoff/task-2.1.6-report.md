# Task 2.1.6 report: indexing evaluation over 12 Shorts

Status: DONE (12/12 passed on Vertex AI)
Branch: worktree-agent-a927b0afd1c20ab35 (reset onto origin/feat/mm/director-hackathon 15bf6b9 first)
Commits: 15bf6b9..bd79ec7
- a445f42 feat(ai): evaluate indexing on 12 real Shorts, the seeds and six hard cases
- bd79ec7 test(ai): an empty Shorts' file fails the indexing evaluation

(The guard refused writing this report to the shared checkout's
`.superpowers/sdd/2026-10-18-director-hackathon/`, so it's at the same relative path
inside the worktree, uncommitted.)

## What changed and why

- `apps/ai/evals/index_shorts.py` (new; `evals/__init__.py` too). Run as
  `bun run --filter @repo/ai evals:index` (new script in `apps/ai/package.json`:
  `bun --env-file=../../.env run uv run python -m evals.index_shorts --live`, the same
  pattern as `seeds:build`). It never reads or prints `.env`.
  - Builds the real indexer the way `scripts/build_seeds.py` does: `create_planner_agent`
    over `create_index_model` for INDEX_MODEL and INDEX_FALLBACK_MODEL, calling
    `app.indexing.index_short` (retries, fallback, `repair_plan`), with the app's own
    per-plan budget (`DIRECTOR_TOKENS_PER_PLAN`), so a Short too long for the app fails here too.
  - Runs the Shorts one at a time (Vertex quotas are per minute).
  - Per Short it prints: PASS/FAIL, videoId, kind, shots, script yes/no, pose yes/no
    (any shot with keypoints), the model that answered, seconds, repaired fields, and
    either the judgement's problems or the indexing error (`ExceptionType: message`,
    which carries the status and body for a refusal). Then a summary line:
    `<passed>/<n> passed, <indexed>/<n> indexed, <k> repaired, models: ..., <s>s in all`.
  - Exits 0 only when there was at least one Short and every one passed. Otherwise it
    exits 1, or 2 without `--live` (so it never spends tokens by accident) or for an
    `--only` id that isn't in the file. `--only <videoId>` (repeatable) re-runs a
    subset; `--shorts <path>` points it at another file.
  - Pass bar (`judge`): every shot has a non-blank scene, a non-blank framing note and
    at least one step with a non-blank instruction. `ShotPlan` already guarantees that
    framing and phoneAngle are *present* (a plan without them fails to index), so the
    judgement checks what can still be empty, since blank text passes `min_length=1`.
  - Repaired fields (`repaired_fields`): diffs Gemini's draft against the repaired plan
    as JSON. It folds list positions (`shots[].durationSeconds` once, not per shot),
    shows a list whose length changed as `<path> (count)`, and sorts the result.
- `apps/ai/app/indexing.py`: `index_short` takes an optional keyword
  `drafted: Callable[[ShotPlanDraft], None] | None = None`. It's called with Gemini's
  answer right before `repair_plan`, through a small `_repaired` helper that both the
  primary and fallback paths use. The default is `None`, so every existing caller
  behaves exactly as before.
- `apps/ai/evals/shorts.json`: the 6 seeds (same order as `app/seeds/seeds.json`) and 6
  hard cases, each with videoId, title, channel, kind, why it's hard.
- `apps/ai/pyproject.toml`: `evals` added to coverage `source`, basedpyright `include`
  and an execution environment (like `scripts`).
- Docs: `apps/ai/CLAUDE.md` (when to run it), `docs/python-services.md` (command table;
  coverage now names `evals/`), `docs/director.md` (next to `seeds:build`).
- Tests: `apps/ai/tests/test_eval_index_shorts.py`, 24 tests.
  - Unit, with the indexing call and the clock injected:
    - shorts.json's shape: 12 unique ids, seeds first in seeds.json order, the 6 hard kinds
    - a malformed id is refused
    - the judgement: a passing plan, and a blank scene, framing or step named per shot
    - the repaired-fields diff: nothing changed, folded indexes with a count change,
      nested lists, a trimmed shot list
    - `evaluate_short`: records the model, time and repairs; fails a plan the judgement
      fails; records an indexing error without stopping the run
    - `evaluate` keeps the order
    - `describe` for a pass, a judgement fail and an index fail, and `summary`
    - `run_eval`'s exit codes; `main` without `--live`, and with an unknown `--only`
  - Integration, against the local Gemini fake in tests/fakes.py (no Vertex):
    - `settings_indexer` returns the draft and the repaired plan, and the fallback's
      draft when the primary model refuses
    - `main` runs only the `--only` Short, and an empty file fails
    - the command, as a subprocess, prints the PASS/FAIL lines and the summary, and
      exits 1 when a Short fails

## The hard cases picked (all verified with the YouTube Data API)

Each was checked with videos.list (public, embeddable, no age rating, no region block,
duration) and with `HEAD youtube.com/shorts/<id>` returning 200 (a Short, not a
redirect to /watch):

| videoId | kind | length | why |
|---|---|---|---|
| dyUed97vESs | no-person | 15s | hydraulic press crushing objects; nobody on screen |
| j8P5uHAvr40 | music-only | 14s | instrumental piano cover, no speech |
| By5itGD3kKo | text-and-doodles | 11s | whiteboard animation, drawn doodles and text |
| cehKajB1bzc | fast-cuts | 16s | "Easy Fast Cut Intro" edit |
| s8AKpO4aT8U | photo-slideshow | 16s | slideshow of photos to a song |
| 2Mn_aH2g0v8 | long | 156s | Hindi day-in-my-life vlog near the 3-minute limit |

I re-checked all 6 seeds the same way. They're still public, embeddable Shorts
(152Jy2c3XSM is blocked only in RU).

I picked these from search results by title and metadata and didn't watch them, so
"more than 15 cuts" is unverified. Gemini returned 7 shots for cehKajB1bzc. Either the
edit has fewer distinct shots than hoped, or the planner merged quick cuts (see concerns).

## Live run (real Vertex AI, gemini-4-argon, sequential)

`bun run --cwd apps/ai evals:index` (same as `--filter @repo/ai evals:index`):

```
PASS 22k0fZarxh8 talking-head shots=9 script=yes pose=yes model=gemini-4-argon 179.4s repaired=none
PASS 152Jy2c3XSM product shots=11 script=yes pose=no model=gemini-4-argon 114.4s repaired=none
PASS _HonL1arbaA recipe shots=10 script=yes pose=no model=gemini-4-argon 98.7s repaired=none
PASS WvGUjw7OwZo travel shots=6 script=no pose=yes model=gemini-4-argon 98.4s repaired=none
PASS 8OLAi6Eba98 text-heavy shots=1 script=yes pose=yes model=gemini-4-argon 24.5s repaired=none
PASS vUZWe5kAsSM dance shots=1 script=no pose=yes model=gemini-4-argon 20.7s repaired=none
PASS dyUed97vESs no-person shots=1 script=no pose=no model=gemini-4-argon 68.8s repaired=none
PASS j8P5uHAvr40 music-only shots=1 script=no pose=yes model=gemini-4-argon 39.5s repaired=none
PASS By5itGD3kKo text-and-doodles shots=3 script=yes pose=no model=gemini-4-argon 25.3s repaired=none
PASS cehKajB1bzc fast-cuts shots=7 script=yes pose=yes model=gemini-4-argon 46.3s repaired=none
PASS s8AKpO4aT8U photo-slideshow shots=11 script=no pose=yes model=gemini-4-argon 60.9s repaired=none
PASS 2Mn_aH2g0v8 long shots=12 script=yes pose=yes model=gemini-4-argon 222.1s repaired=durationSeconds
12/12 passed, 12/12 indexed, 1 repaired, models: gemini-4-argon=12, 999s in all
exit=0
```

The log has no retries, no fallback and no warnings. Only the long Short needed repair
(the plan's total `durationSeconds`). It also hit exactly `MAX_SHOTS` = 12 and took 222s.

## Checks

- TDD, first run before the module existed:
  `bun run --cwd apps/ai test -- tests/test_eval_index_shorts.py` ->
  `ModuleNotFoundError: No module named 'evals'` / `1 error during collection`.
  After the module existed, one of my own tests was wrong: the summary test expected
  "1/3 passed" when two of its three results pass. I fixed the expectation. Then
  `19 passed, 4 deselected`.
- `bun run --cwd apps/ai test -- tests/test_eval_index_shorts.py -m integration` -> `5 passed, 19 deselected`.
- `bun run --filter @repo/ai check-types` -> `0 errors, 0 warnings, 0 notes`.
- `bun run --cwd apps/ai lint` (ruff check, ruff format --check, deptry) -> `Success! No dependency issues found.`
- `bun run lint` (repo-wide) -> every step passed, exit 0.
- `bun run gen` -> no drift.
- Coverage on stack 5 (`bun run setup --stack 5`, then `bun run --filter @repo/ai coverage`):
  - `evals/index_shorts.py 137 0 34 0 100%` and `app/indexing.py 100%`
  - `TOTAL 1900 0 270 0 100%`, `Required test coverage of 100.0% reached`, `250 passed`
  - `bun scripts/coverage.ts` lists no apps/ai file below 100%. The other files it
    lists belong to packages whose suites I didn't run.
  - I stopped the stack afterwards with `bun run db:down`.
  - The first coverage run had 1 failure,
    `tests/test_service.py::test_the_worker_runs_and_stops_cleanly_without_director_s_model`
    (worker exit -15), so it reached only 99.72%. That failure isn't from this change.
    The owner's dev AI worker (another checkout, `watchfiles ... app.worker`) keeps
    writing the shared heartbeat file `$TMPDIR/ai-worker-alive`. So the test saw
    "alive" before its own worker had installed its signal handler, and stopped it too
    early. A re-run with a private `TMPDIR` gave 250 passed and 100%. That test will
    flake whenever a local AI worker is running.

## Decisions the brief didn't make

- Output goes through `app/log.py` (`log.info(<line>)`) at info level whatever LOG_LEVEL
  says, not `print` (ruff T20 and the python rules).
- `--live` is mandatory (exit 2 without it). I added `--only` to re-run one Short and
  `--shorts` to test the command without touching the real list.
- Each Short gets the app's per-plan token budget, so the eval fails on anything the
  app itself would fail on.
- `repaired_fields` compares shots by position: if repair reorders shots, every moved
  field shows up. Its docstring says so.
- A Short that fails to index gets a FAIL line with its reason and the run carries on,
  so one bad Short doesn't hide the others. `log.exception` records its traceback too.

## Concerns

- The fast-cuts pick (cehKajB1bzc) came back as 7 shots. I couldn't confirm it really
  has more than 15 cuts without watching it. If the bar needs a >15-cut Short, swap in
  one someone has watched.
- 4 Shorts came back as a single shot: the text-heavy and dance seeds, no-person and
  music-only. That passes the bar and is probably right for one-take videos. Someone
  should still check the hydraulic-press plan to see whether one shot is right for it.
- `.claude/rules/python.md` still says coverage covers `app/` and `scripts/`. I left
  the rules file alone because it's part of the Claude setup; it should also name `evals/`.
- The worktree's untracked `.env`/`.env.stack` now use stack 5's ports, from
  `setup --stack 5`. Only localhost URLs moved; the real Google settings didn't change.
