#### Task 2.1.1: Prompt and schema for any Short
**Files:** `apps/ai/app/director.py` (PLAN_INSTRUCTIONS, `_planner`), `apps/ai/app/schemas.py`, `apps/ai/tests/test_director.py`.
- [ ] Extend `PLAN_INSTRUCTIONS` for: no person (pose empty, framing = object), no speech (script from on-screen text when it carries the story), on-screen text/doodles (carry as script lines + steps), fast cuts (merge cuts < 0.5 s), slideshows (photo shots), > MAX_SHOTS cuts (merge adjacent), and `purpose` = the scene's role (hook/setup/reveal/payoff) and intended feeling.
- [ ] `ShotPlan` gains `sceneRoles` nowhere new — keep the schema; only `Shot.purpose` description tightened. (No contract change.)
- [ ] Planner uses `INDEX_MODEL`; `VideoUrl` with `vendor_metadata`/`video_metadata` fps=3, media resolution medium (pydantic-ai `GoogleModelSettings`).
- [ ] Tests with the fake Google (canned plans) for: no-person plan accepted, no-speech plan accepted.

