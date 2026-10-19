# fix/mm/ci-green: status

Head: e4363ef90fdba1fa2a02c0298668d25cd4559fc8, rebased on master 8066e7bd (#47). It is pushed. Not all local checks are green yet: the Coverage job still has a large gap (see the end).

## Checks run locally (stack 6)

| Check (CI job) | Result | Notes |
|---|---|---|
| `bun run lint` (Lint and boundaries) | pass | |
| `bun run check-types` (Type-check) | pass | |
| `bun run type-coverage` (Type-check) | pass | |
| `bun run test` (Unit tests) | pass | The `env.test.ts` port tests time out only when the machine is overloaded (load 30 to 48 from other agents); alone they pass |
| `bun test ./scripts/ ./.claude/hooks/` | pass | 985 tests |
| Python: ruff, ruff format, basedpyright, pytest (Python service) | pass | |
| Python: `bun run coverage` (unit and integration) | 576 tests pass; coverage ~99.7% before the last test commits | All gaps on the earlier run are now tested (assets, picker, aligner, clips, create, director, settings, session recordings) |
| Integration, per package (Integration tests) | pass for db, nest-common, worker, webhooks, notifications, jobs, client, contracts, fake-google, ai-client, api | api: one recording test timed out under load in a full run and passed alone. Postgres on stack 6 crash-restarted twice during a run ("untracked child process exited with exit code 2"), local only |
| web browser tests (Integration tests) | the failures I could reproduce are fixed; the rest of a full run's failures were 30 s timeouts under load | not re-run clean on an idle machine |
| `bun run test:coverage` merged (Coverage) | fail | 90 of 670 files below 100%; see below |
| `bun scripts/generators.ts` (Code generators) | not run locally | the CI failure was the worker's type error, which is fixed |
| `bun run test:e2e` (End-to-end) | not run locally | the CI failure (demo.spec alert strict-mode clash) is fixed |
| API compatibility | no change | this branch doesn't touch either openapi.json or the event catalog, so no `!` is needed in the PR title. #37's removal of the scene-check route is already on master, so CI compares this branch with a base that doesn't have the route |

## What I fixed

- worker: tsconfig gets the DOM lib for the AI client's fetch types (Type-check, Code generators)
- client: a typed cursor value in the slice store (type-coverage)
- ai: the aligner tests that need ffmpeg (master's new ones too) are marked integration, because the unit job has no ffmpeg (Unit tests)
- scripts: image-smoke reads only the service's own settings; the pre-push tests read this checkout's ports
- db: enums test lists the recording CHECKs and the asset origins (Integration)
- ai tests: per-shot B-roll slots in the picker
- web e2e: demo's alert is found by its text (End-to-end 2/4)
- worker: the clipper's AI stand-in answers a full, schema-checked take (Integration)
- web tests: a finished test's late UNAUTHENTICATED redirect no longer empties the next test's page (render.tsx); the AI stand-in serves asset slots; the roll intro copy
- api: publish's AI-footage check reads only the asset slots; the publish tests' AI stand-in serves them; a new test checks a chosen Veo clip is declared to YouTube; fake-google keeps `containsSyntheticMedia`
- ai: `RecordingJobName` typed on the clip queue; dropped the dead `Artist.draw`; many new tests (routes for editor and match cuts, gap clips on Vertex, Veo clips, create retries and budget, the aligner's settings, the picker's refusals, the recording source against the database and storage, and so on); the storage stand-in answers 404s and DELETE the way Cloud Storage does

## Real bugs found

1. The post-session pass could never add an attempt. It used `ON CONFLICT (session_id, part_index, start_ms)` with no matching unique index, so Postgres refused every insert. Master #43 has since fixed it the same way, and my test for the pass's recording source is kept alongside master's.
2. Publishing's check for AI footage loaded the whole asset picker: the plan, plus a signed link for every image. It now reads the slots only. This was not a correctness bug, but it was wasted work on every publish.

## Coverage: what's left (the decision for you)

`bun scripts/coverage.ts` reports 90 files below 100%. Most are today's slices' web UI and hooks, which shipped with no browser tests at all:

- asset-picker, tell-director, brief-photos, roll-parts, match-cut, match-ghost, slot-preview, gap-strip, what-you-need, marks-layer, memory-chips, created-hero
- use-marks, use-roll, use-roll-shoot, use-dictation, use-match-cuts, use-tell-director
- lib: compose, dictation, visuals, slow-session, stitch, scene
- pages: create and created (and their routes, which no test loads), plus large parts of edit and shoot
- api: assets.service and router, editor service and router, director.service (brainstorm, create, editPlan, locate), live relay, chat and setup branches, stock providers
- client: the assets and create-template hooks
- worker: files.processor's normaliseAssetImage
- ui: dropdown-menu and select sub-parts
- ai-client: the asset, template and editor calls

This is days of test writing, not a CI fix. Some of the gaps may shrink once a run isn't hit by load timeouts, but most of these files have no test at all. It splits cleanly by package: web components and hooks, web pages, api, client and ui. Parallel agents could each take one area.
