#### Task 2.1.2: Repair instead of fail
**Files:** create `apps/ai/app/plan_repair.py`; test `apps/ai/tests/test_plan_repair.py`.
- [ ] `def repair_plan(plan: ShotPlan, video_seconds: float | None) -> ShotPlan` — sorts shots by `sourceStartSeconds`, clamps source ranges into `[0, video_seconds]`, removes overlaps (end = next start), drops shots < 0.3 s, clamps `durationSeconds` to `[0.5, MAX_SHOT_SECONDS]`, clamps script lines into `[0, durationSeconds]` and drops empty ones, clamps steps' `atSeconds`, recomputes `ShotPlan.durationSeconds` as the sum. **[RF 2]**
- [ ] Tests: `test_repair_sorts_and_removes_overlaps`, `test_repair_clamps_script_into_shot`, `test_repair_keeps_a_valid_plan_unchanged`, `test_repair_drops_slivers_but_keeps_one_shot`.
- [ ] `analyze` calls `repair_plan` before saving.

