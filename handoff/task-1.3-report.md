# Task 1.3 report: local dev and the running app use the real Google services

(Written inside the worktree, since the dispatch's report path
`/Users/manas.madan/Desktop/code/director-editor/.superpowers/sdd/2026-10-18-director-hackathon/task-1.3-report.md`
is outside this worktree and the write guard refused it.)

## Status

DONE

Commit range: `1ea8e58..e0401d6` (one commit, `e0401d6`, on
`worktree-agent-ab39903bc53d9856f`, branched from
`origin/feat/mm/director-hackathon`). Not pushed, not merged.

Test summary: every unit, scripts/hooks, apps/api and apps/web integration suite passes
(see below); apps/ai's full suite (unit + integration) passes at 100% coverage for every
file this task touched.

## What changed and why

The owner's rule (2026-10-18): no hard-coding, fakes, mocks or stubs anywhere except
tests. `bun dev` and `bun dev:full` must call the real Gemini (via Vertex AI or the
Gemini API) and the real YouTube Data API v3; `packages/fake-google` stays, but only as
a fixture for integration, e2e and fuzz suites.

1. **`bun dev:full` no longer starts the mock Google.** The only place it was wired into
   dev was `packages/fake-google/package.json`'s own `"dev"` script — `bun dev:full` runs
   `turbo run dev` with no filter, which picks up every package's `dev` script, including
   the fake's. I dropped that script (kept `"start"`, which `bun run google:fake` still
   uses by hand, and which `apps/web/test/global-setup.ts` still starts programmatically
   via `startFakeGoogle`). I confirmed with `turbo run dev --dry=json` that
   `@repo/fake-google#dev` now resolves to `"command": "<NONEXISTENT>"` — a no-op in the
   task graph. There was no docker-compose service for it to remove (`grep` for
   `fake-google`/`12112` in `docker-compose.yml` found nothing), and nothing in
   `scripts/services.ts`, `setup.ts`, `doctor.ts` or `ports.test.ts` referenced it, so
   those needed no changes. I updated the doc/comment mentions of it in
   `CLAUDE.md` (command table + ports paragraph), `README.md`, `docs/environment.md`,
   `docs/director.md`, `.claude/skills/dev/SKILL.md`,
   `packages/fake-google/package.json`'s description, and the doc comments in
   `packages/fake-google/src/index.ts` and `main.ts`, all to say it's a test fixture that
   never runs as part of `bun dev`/`bun dev:full`. `docs/architecture.md`,
   `docs/testing.md`, `docs/python-services.md`, `.claude/rules/security.md`,
   `.claude/rules/python.md` and `.claude/agents/security-reviewer.md` already described
   it correctly as a test-only stand-in production refuses, so I left those alone.

2. **`.env.example` now points at the real services, keys empty.** `DIRECTOR_MODEL`,
   `GOOGLE_API_KEY`, `GOOGLE_BASE_URL` and `YOUTUBE_API_KEY` are empty (Director off
   until a real key is set); `YOUTUBE_API_URL`'s mock line is commented out, since
   `apps/api/src/env.ts` already defaults it to the real YouTube endpoint;
   `INDEX_MODEL=gemini-4-argon` and `INDEX_FALLBACK_MODEL=gemini-3.1-pro-preview` (both
   already `apps/ai/app/settings.py`'s own defaults — no validator ties them to a key, so
   setting them doesn't risk boot). `GOOGLE_CLOUD_PROJECT` stays empty.

   **Decision the brief flagged, plus one it didn't:**
   - `GOOGLE_VERTEX=true` is `.env.example`'s new default (so a key someone adds later is
     billed through Vertex without an extra step). The brief's own note is right that this
     conflicts with `_vertex_has_a_project`'s validator (`GOOGLE_VERTEX=true` with no
     `GOOGLE_CLOUD_PROJECT` used to fail at boot even with no key at all). I picked the
     brief's second option: the validator now only requires the project once
     `GOOGLE_API_KEY` is actually set (`apps/ai/app/settings.py`'s `_vertex_has_a_project`).
     `GOOGLE_VERTEX=true` with nothing else set is now harmless, and it still refuses the
     half-configured case (a key, Vertex on, no project) the validator exists to catch.
   - I found the same shape of problem the brief didn't call out: `DIRECTOR_MODEL` is
     also validated (`_director_has_a_key`: a model name without a key fails at boot), so
     the brief's literal suggested default (`DIRECTOR_MODEL=gemini-3.8-flash` with
     `GOOGLE_API_KEY` empty) would have broken `bun dev` the same way — I checked this
     empirically before touching anything (a scratch script constructing `Settings()`
     with those exact values raised `"DIRECTOR_MODEL needs GOOGLE_API_KEY"`). I resolved
     it the same way as the brief's own Vertex case: `DIRECTOR_MODEL` stays empty in
     `.env.example` (feature off), with a comment naming `gemini-3.8-flash` as the model
     to set alongside a real key. I did not weaken `_director_has_a_key` itself, since
     unlike Vertex's validator it isn't gating on a variable (`GOOGLE_API_KEY`) that can
     be empty in the "nothing configured yet" case — `DIRECTOR_MODEL` is the feature's own
     on/off switch (`apps/ai/CLAUDE.md`: "Director is off (FEATURE_DISABLED) until
     DIRECTOR_MODEL is set"), so leaving it empty is the correct "off" state, not a
     workaround.

   `scripts/setup.ts`'s `syncEnv()` still boots a fresh `.env` correctly: I ran it
   against a scratch copy of the real `.env.example` (not the repo's own `.env`, which I
   never touched or read) and confirmed the generated file has `GOOGLE_VERTEX=true`,
   every Google/YouTube key empty, `DIRECTOR_MODEL` empty, and the real `INDEX_MODEL`/
   `INDEX_FALLBACK_MODEL` names.

3. **No TODO/FIXME/XXX/HACK markers.** `rg -n "TODO|FIXME|XXX|HACK" apps packages
   scripts deploy infra --glob '!**/node_modules/**' --glob '!**/generated/**' --glob
   '!**/.venv/**'` found only `"XXXX.DUMMY.TOKEN.XXXX"` in `apps/web/test/turnstile.ts`
   and `apps/web/test/users.ts` — Cloudflare Turnstile's own dummy-token literal in test
   fixtures, not a marker. Nothing to fix.

4. **No canned results or hard-coded fallbacks.** I had a fork search `apps/ai`,
   `apps/api` and `apps/web` (excluding tests and `packages/fake-google`) for placeholder
   plans, fixed scores, sample transcripts or other fabricated provider output. It found
   none: `apps/ai/app/director.py` returns `None`/raises real errors
   (`FEATURE_DISABLED`, `UPSTREAM_UNAVAILABLE`) rather than synthesizing output when a
   provider isn't configured or fails, and the API's YouTube client either parses a real
   response or throws. The only "fallback"-shaped hits were legitimate (the
   `INDEX_FALLBACK_MODEL` name, an `AvatarFallback` UI component, HTTP error-code
   mapping).

5. **Mailpit**: left untouched, as instructed (a real SMTP server, not a mock of an
   API).

## TDD evidence

`apps/ai/app/settings.py`'s `_vertex_has_a_project` change: I first edited
`apps/ai/tests/test_units.py::test_vertex_needs_the_cloud_project_once_a_key_is_set` to
assert `GOOGLE_VERTEX=true` alone boots (`google_cloud_project is None`, no raise), and
ran it red against the unmodified validator:

```
$ uv run pytest tests/test_units.py -k vertex -q
...F.. 1 failed, 3 passed
ValidationError: GOOGLE_VERTEX=true needs GOOGLE_CLOUD_PROJECT
```

Then changed the validator to gate on `google_api_key` too, re-ran green:

```
$ uv run pytest tests/test_units.py -k vertex -q
.... 4 passed
```

That surfaced a second, cascading failure across `tests/test_director.py` and
`tests/test_service.py`: their fixtures turn Director on with a bare `GOOGLE_API_KEY`
(no `GOOGLE_VERTEX`/`GOOGLE_CLOUD_PROJECT`), so once `.env.example`'s new
`GOOGLE_VERTEX=true` became the process's baseline (loaded by
`tests/__init__.py::apply_test_environment()`), every one of them started hitting the
same validator. Fixed by pinning `"GOOGLE_VERTEX": "false"` in `tests/support.py`'s
baseline `ENV` (tests that want Vertex already set it explicitly, e.g.
`test_director.py`'s `test_indexing_on_vertex_addresses_the_model_by_its_resource_name`,
which pairs it with `GOOGLE_CLOUD_PROJECT`). Confirmed:

```
$ uv run pytest -m "integration or not integration" -q
116 passed
```

## Checks run, with output tails

```
$ bun run lint
...
  ✔ bunx turbo run lint
(one pre-existing, unrelated warning in scripts/image-scan.test.ts — a template-string
lint suggestion in a file I didn't touch)

$ bun run check-types
 Tasks:    24 successful, 24 total

$ bun run test
 Tasks:    22 successful, 22 total
(apps/ai: 71 passed, 45 deselected — the integration-marked ones, excluded by default)

$ bun test ./scripts/ ./.claude/hooks/
 972 pass
 0 fail

$ uv run pytest -m "integration or not integration" -q   # apps/ai, unit + integration
116 passed

$ bun run --filter @repo/ai coverage
app/settings.py   43  0  6  0  100%
(repo total is 99.68%, short only on apps/ai/app/telemetry.py lines 44-45/56->62 — a
pre-existing gap I didn't touch; confirmed with `git log -- apps/ai/app/telemetry.py`,
last changed in the initial commit, no diff here)

$ bun run --filter @repo/api test:integration
 Test Files  8 passed (8)
 Tests  96 passed | 13 skipped (109)

$ bun run --filter @repo/web test:integration
 Test Files  51 passed | 1 skipped (52)
 Tests  307 passed | 16 skipped (323)
(this is the suite that starts the mock Google itself, via
apps/web/test/global-setup.ts — confirms the test fixture still works)

$ bun run type-coverage
(fails only on a pre-existing "Unused ignore line directive" in
packages/i18n/src/index.ts:51, unrelated to anything in this task — packages/fake-google
itself passes: "✔ packages/fake-google")
```

`bun run gen` was run at setup and is drift-free (no uncommitted changes under any
generated path).

## Things I decided that the brief didn't spell out

- Left `DIRECTOR_MODEL` empty in `.env.example` rather than `gemini-3.8-flash`, for the
  reason above (it would fail boot the same way the brief flagged for `GOOGLE_VERTEX`).
- Chose "fix the validator" over "leave `GOOGLE_VERTEX` off" for the Vertex/project
  conflict, since the brief's intent (a key added later should default to billing
  through Vertex) only works if `GOOGLE_VERTEX=true` survives a key-less boot.
- Pinned `GOOGLE_VERTEX=false` in `apps/ai/tests/support.py`'s baseline `ENV`, matching
  the existing pattern there for `DIRECTOR_MODEL`/`GOOGLE_BASE_URL` (explicit "off"
  overrides so tests control their own Director config per test).
- A docker-compose `up` I ran for integration tests (`bun run db:up`) recreated the
  already-running `director-editor-postgres-1` container (compose reported
  "Recreate"/"Recreated" for it, unrelated to anything I changed — I never touched
  `docker-compose.yml`). It came back up healthy on the same port immediately; I didn't
  investigate further since I didn't start or stop anything else and no test failed
  because of it, but flagging it since the brief says not to touch containers I didn't
  start.

## Concerns

- None blocking. The `director-editor-postgres-1` recreate above is worth a glance if
  the owner notices anything odd about that container's history.
