# Task 1.3: the running app and local dev use the real Google services; fakes only in tests

## Why

The owner's rule (2026-10-18): no hard-coding, fakes, mocks or stubs anywhere except
tests. The running app and `bun dev` / `bun dev:full` use the real services (Gemini on
Vertex AI, the YouTube Data API, Gemini Live, Cloud Storage). `packages/fake-google` and
any other fake stay, but only as test fixtures (integration tests, e2e, fuzzing).
`.env.example` never points at a mock. No TODOs remain in code. No hard-coded
user-facing text or canned results in app code.

## What to change

1. `bun dev:full` no longer starts the mock Google (`@repo/fake-google`, port 12112).
   Find every place that wires it into dev: root `package.json` scripts, `turbo.json`
   tasks, `scripts/dev*.ts` / `scripts/services.ts` / `scripts/setup.ts` /
   `scripts/doctor.ts`, `.env.example`, `docs/environment.md`, `CLAUDE.md`'s command
   table and ports paragraph, `docs/` pages that describe dev. Keep the package itself
   and its use from tests (integration/e2e/fuzz harnesses start it themselves, the way
   they do now or by a test-only script). `scripts/ports.test.ts` and any test that lists
   dev ports must still pass.
2. `.env.example` defaults point at the real services, keys empty, so a feature stays off
   until its key is set (the repo's existing "features switch on when their variables
   are present" rule):
   - `GOOGLE_VERTEX=true`, `GOOGLE_API_KEY=` (empty), `GOOGLE_BASE_URL=` (empty or removed
     from the example), `DIRECTOR_MODEL=gemini-3.8-flash`, `INDEX_MODEL=gemini-4-argon`,
     `INDEX_FALLBACK_MODEL=gemini-3.1-pro-preview`, `VERTEX_LOCATION=global`,
     `GOOGLE_CLOUD_PROJECT=` (empty), `YOUTUBE_API_KEY=` (empty), any `*_BASE_URL` that
     points at localhost:12112 removed or emptied. Check each service's `src/env.ts` /
     `apps/ai/app/settings.py` accepts the empty values (empty = off) and that the
     settings validators don't refuse the example as written (`GOOGLE_VERTEX=true`
     requires `GOOGLE_CLOUD_PROJECT` in apps/ai: then either the example leaves
     `GOOGLE_VERTEX` off until a key is set, or the validator only requires the project
     when a key is present: pick the one that keeps `bun run setup` + `bun dev` booting
     with no keys, and say which in your report).
   - `scripts/setup.ts` writes `.env` from `.env.example`: a fresh setup must boot.
   - `apps/ai/tests/test_settings_documented.py` and similar docs-vs-settings tests pass.
3. No TODO/FIXME/XXX/HACK markers in code (`rg -n "TODO|FIXME|XXX|HACK" apps packages
   scripts deploy infra --glob '!**/node_modules/**'`), fixed properly, not reworded.
   Generated code and vendored skills excepted.
4. No canned results or hard-coded fallbacks that pretend to be real output in app code
   (e.g. a placeholder plan, a fixed review score, a sample transcript returned when the
   provider isn't configured): when a provider isn't configured the feature is off and
   says so through an error code, not fake data. Search apps/ai, apps/api, apps/web for
   them. Seed data used only by tests/fixtures is fine; the demo-user seed that `bun run
   setup` creates for local sign-in is fine.
5. Mailpit stays as the local SMTP catcher (ruling: it is a real SMTP server, not a mock
   of an API; production sends through Stalwart → Resend). Leave it.

## Tests

Whatever the existing tests for scripts/setup/doctor/ports/env docs need, updated; a new
or changed script behavior gets a scripts test. Run: `bun run lint`, `bun run
check-types`, `bun run test`, `bun test ./scripts/ ./.claude/hooks/`, `bun run
--filter @repo/ai test`, and prove a fresh setup boots: run `bun scripts/setup.ts` (or
the repo's documented equivalent) against a scratch copy of `.env.example` written to a
temp path if the script supports it, otherwise reason from the code and say so. Do NOT
start or stop the owner's running dev stack and do NOT overwrite the repo's `.env`.
