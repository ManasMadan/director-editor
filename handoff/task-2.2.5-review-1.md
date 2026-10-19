(Review 1 of task 2.2.5 — fix all; file:line refer to branch worktree-agent-a26d85d324511cc56 at 5ffd8d4.)

Important
1. apps/ai/pyproject.toml:116 / apps/ai/scripts/build_seeds.py:118-151 — scripts/ was added to basedpyright's scope but not to coverage (`[tool.coverage.run] source = ["app"]`), leaving settings_indexer, main and the __main__ guard unmeasured, with no docs/testing.md exception. Fix: add "scripts" to coverage source; cover settings_indexer through the tests/fakes.py Gemini stand-in (the way the Director tests point INDEX_MODEL at it); cover main() with temp paths; if the `__main__` line can't reasonably be covered, list it in docs/testing.md with its reason.

Minor
2. apps/ai/tests/test_build_seeds.py:160 — test_seed_template_refuses_a_plan_with_no_shots validates a bare ShotPlan, not SeedTemplate: validate a SeedTemplate with an empty plan, or drop it.
3. apps/ai/scripts/build_seeds.py:33-34,44 — replace the sys.path hack and the ad-hoc run command with a named script in apps/ai/package.json, e.g. `"seeds:build": "bun --env-file=../../.env run uv run python -m scripts.build_seeds"` (cwd apps/ai makes `app` importable); update the docstring and docs (docs/director.md or apps/ai/CLAUDE.md) to say `bun run --filter @repo/ai seeds:build`. Keep templates.json as committed (no re-run needed).
