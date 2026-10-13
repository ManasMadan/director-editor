---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/test/**"
  - "**/e2e/**"
  - "apps/ai/tests/**"
  - "packages/vitest-config/**"
  - "packages/fake-stripe/**"
---

# Tests

Which kind goes where:

| Kind | Location | Runs with | Needs |
|---|---|---|---|
| Unit | `src/**/*.test.ts` next to the code (Jest in `apps/mobile`) | `bun run test` (cached; the Stop hook runs it for affected packages, and fails on a changed line of a unit-tested file it doesn't cover, in packages without integration tests: `bun scripts/unit-coverage.ts`) | nothing |
| Scripts, hooks and the rest of the tooling | `scripts/*.test.ts`, `.claude/hooks/*.test.ts` (Bun's runner); the tooling outside `src/` (build scripts, presets, generators, the load test, `deploy/docker/check-peers.mjs`) is tested from `scripts/` too | `bun test ./scripts/ ./.claude/hooks/` | nothing |
| Integration | `<pkg>/test/**/*.test.ts` (apps name them `*.integration.test.ts`) | `bun run test:integration` (the core services); suites tagged `files` (RustFS, ClamAV) with `bun run test:integration:files` | Docker (the command starts it) |
| Web pages and components | `apps/web/test/**/*.test.tsx`, in Chromium against the real API | `bun run --filter @repo/web test:integration` | Docker, Chromium |
| E2E (web) | `apps/web/e2e/*.spec.ts` | `bun run test:e2e --app web` | full stack |
| E2E (mobile) | `apps/mobile/e2e/*.spec.ts` (react-native-web); native flows in `apps/mobile/maestro/` | `bun run test:e2e --app mobile` | full stack |
| Python | `apps/ai/tests/test_*.py`, `pytest.mark.integration` for DB/Redis | `bun run test` / `bun run test:integration` | Docker for integration |
| Components | `packages/ui/src/components/*.stories.tsx` with `play`, plain `*.test.tsx` beside them | `bun run --cwd packages/ui test:stories` | Playwright browser |
| Fuzzing | every operation of `apps/api/openapi.json` and `apps/ai/openapi.json`, settings in `schemathesis.toml` | `bun run test:fuzz` (or `bun run test:e2e --app fuzz`) | a running API and AI service |

- Unit tests are pure: no network, no database, no clock you don't control. They are
  cached by turbo, so a hidden dependency gives stale results.
- Anything that touches Postgres, Valkey, email, auth or HTTP is an integration test
  against the real service. Do not mock Prisma, Redis, BullMQ or the database; a mock
  would hide exactly the RLS, grant and serialization bugs these tests exist for.
- Integration tests connect as the service's own role (`createTestDatabase().urlFor(role)`
  from `@repo/db/testing`), each file on its own cloned database, so a missing grant or
  policy fails here. Build data with `factories(db)`, not raw inserts.
- Third-party providers are replaced by local fakes that speak the real protocol:
  `packages/fake-stripe`, `apps/notifications/test/fake-twilio.ts` and `fake-push.ts`,
  Mailpit for email, the `local:extractive` model and `hashing` embeddings for AI. New
  providers get a fake like these, not `vi.mock`.
- `packages/client`'s hooks run against the contract implemented in memory
  (`standIn` and `renderHook` in `packages/client/test/stand-in.tsx`), never a mocked
  `fetch`; each test implements only the procedures it calls.
- Every source file is at 100% (lines, branches, functions), every suite merged.
  `bun run test:coverage` runs them all and names what each file misses (it needs the
  full Docker profile and takes minutes: run it in the background); `bun run --filter
  @repo/<name> coverage && bun scripts/coverage.ts` rechecks after one package's run. A
  file below 100% is either tested, trimmed, or listed with its reason in "Coverage
  exceptions" in docs/testing.md. No coverage pragmas. The `test-writer` agent writes
  missing tests.
- No fixed sleeps. Wait for the condition with `eventually` (`@repo/testing/eventually`),
  `vi.waitFor` or `expect.poll`; to prove something didn't happen, wait for a signal that
  the work finished (job completed, row written, `PUBSUB NUMSUB`), then check once.
- A bug fix starts with a test that fails without the fix. One the fuzzing finds (a 5xx,
  or an answer the OpenAPI document doesn't declare) gets an integration test in
  `apps/api/test` too; something the API does on purpose that Schemathesis can't read is
  configured in `schemathesis.toml`, with a comment saying why.
- Tenancy changes need a test that a second organization cannot see or change the row.
