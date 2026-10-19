# Coverage report: PR #8 (feat/mm/director-hackathon)

Status: DONE_WITH_CONCERNS (only the concerns listed at the end)

Branch: `worktree-agent-a8a9509d227326b96`, reset to `origin/feat/mm/director-hackathon` at
71d4f57. Commits `1f20d85..2cbe2bc` (3 commits, `--no-verify`, not pushed):

- 1f20d85 `test(api): cover deleting a team workspace and a rotated auth secret`
- f754e08 `test(web): refuse the avatar upload on this checkout's storage port`
- 2cbe2bc `refactor(api)!: remove the builders, hooks and helpers nothing reaches any more`

I ran everything on stack 8 (`bun run setup --stack 8`, `bun run db:up:full`, which includes
RustFS, ClamAV, Stalwart and Jaeger) and stopped it afterwards with `bun run db:down`. The
guard refused the shared report path, so this report is at the same relative path inside my
worktree, and it isn't committed.

## How I ran coverage

`bun run test:coverage` in one go failed on this machine for load reasons, not for code
reasons. The load average was 30 to 50 on 10 cores. The `packages/ui` browser tests timed
out on clicks and screenshots, and turbo then cancelled the rest. So I ran the same steps one
at a time:

1. `bun run --filter @repo/ui coverage` on its own: 51 files and 93 tests passed.
2. `bunx turbo run coverage --filter=!@repo/ui --continue --concurrency=3`, with the
   Stalwart variables set to stack 8's ports, the way CI's integration job sets them
   (`STALWART_URL`, `STALWART_SMTP_URL`, `STALWART_MAILPIT_URL`).
3. `bun test --coverage ./scripts/ ./.claude/hooks/`
4. `bun scripts/coverage.ts`

Baseline merge on 71d4f57: `524 source files, 19 reports: 12 below 100%`. Five of the twelve
came from tests that timed out under load: `director.tsx`, `live-call.tsx`, `call-audio.ts`
and `shot-list.tsx` (the `apps/web/test/director/*` suites), plus one worker test. Those
tests pass and cover their files in the later runs, and none of my changes touch them. The
other seven are below.

## Each file below 100%: decision and change

| File (baseline gap) | Decision | Change |
|---|---|---|
| `apps/api/src/auth/auth-plugins.ts`: 86-88 (`afterAcceptInvitation`), 180-181 (`afterCreateInvitation`), branch 163 | **Removed (dead).** `WORKSPACE_MEMBER_LIMIT` is 1, and better-auth only lets an existing member invite, so `members + pending >= 1` is always true. Every invitation is refused, so the after-hooks can never run, and the false branch of 163 can't be reached. | `beforeCreateInvitation` now refuses every invitation outright. It still answers 403 `FORBIDDEN`, and the existing test "refuses an invitation" covers it. The comment explains that raising the limit means counting members and pending invitations again. better-auth checks `membershipLimit` only when an invitation is accepted, so this hook is what keeps invitations from piling up. I also removed the after-hooks, the `invitationExpiresIn` and `invitationLimit` options, `INVITATION_DAYS`, and `PENDING_INVITATION_LIMIT` from contracts. |
| `auth-plugins.ts`: 155, 171-172, branch 149 (team workspace deletion) | **Kept and tested (reachable).** A non-demo user can still create a team workspace with `/organization/create` and delete it. | New integration test in `api.integration.test.ts`: "an owner deletes a team workspace: its members lose access at once, and it's recorded". With `forgetOrganization` commented out it fails (`expected 'FEATURE_DISABLED' to be 'NO_ACTIVE_ORGANIZATION'`), and it passes with it in. The personal-workspace refusal stays and its test still passes. |
| `apps/api/src/auth/memberships.ts`: `forgetOrganization` | **Kept and tested.** The team deletion above reaches it. | Covered by the same test. |
| `apps/api/src/auth/account-limits.ts`: 157, 160 (invitation email limits) | **Removed.** They limited invitation emails per inviter and per recipient. This PR removed `sendInvitationEmail`, so no invitation email is ever sent, and the invitation itself is always refused. The limit guarded nothing. | I removed `emailLimits.invitation`, its two limiters and the `/organization/invite-member` branch in `auth-hooks.ts`. The per-recipient code limit stays: same Redis key name, 10 an hour. `EMAIL_LIMITS` is folded in because knip flagged it once nothing else read it. |
| `apps/api/src/rpc/procedures.ts`: `fresh` and `orgAdmin` | **Removed (dead).** No router uses either, including the publish module in progress, which uses `inOrg` only. | I removed both builders, then `canManageWorkspace` (its only caller was `orgAdmin`) and its unit test, and then the `FRESH_SESSION_REQUIRED` error code (thrown only by `fresh`). That means the code in `errors.ts`, its en.json message, and `bun run gen` for the generated contracts and AI openapi. `router.test.ts`'s `BUILDER_CODES` is updated. Docs updated: `docs/auth.md`, `apps/api/CLAUDE.md`, `.claude/rules/api.md` and `security.md`, the reviewer and security-reviewer agents, and the add-feature skill. |
| `packages/db/src/tenancy.ts`: `userTx` | **Removed (dead).** Nothing calls it. Its callers were the notifications module, which the PR removed. | `withUser`'s blocked `$transaction` message now says a multi-statement per-user unit needs a transaction that sets the user first. Updated `security.test.ts`, `packages/db/CLAUDE.md`, `docs/database.md`, `docs/architecture.md`, `.claude/rules/api.md` and the db-change skill. |
| `apps/notifications/src/channels/email/email.channel.ts`: branch 25 | **Removed (dead), not environment-only.** It stayed uncovered with the Stalwart suites running too. The only caller (`dispatcher.ts`) never passes `headers`. The List-Unsubscribe senders were removed. | I dropped the `headers` parameter. `OutgoingEmail.headers` on the transport seam stays, and `stalwart.integration.test.ts` still exercises it. |
| `apps/api/src/auth/auth.ts`: branch 129 (`BETTER_AUTH_SECRETS`) | **Real gap, not environment-only.** CI sets no `BETTER_AUTH_SECRETS`. On master, `oauth.integration.test.ts` started an API with it, and the PR deleted that file. | New `apps/api/test/secret-rotation.integration.test.ts` (Redis db 4, which the deleted test used). It starts an API with `BETTER_AUTH_SECRETS=2:...`. Test 1: a new 2FA secret is stored as `$ba$2$...` and decrypts with the newest secret alone. Test 2: a secret re-written under `BETTER_AUTH_SECRET` alone (from before rotation) still passes TOTP sign-in. Both tests also passed with the `secrets` option deleted. better-auth reads `BETTER_AUTH_SECRETS` from the environment itself (`options.secrets ?? parseSecretsEnv(env.BETTER_AUTH_SECRETS)`, `better-auth/dist/context/create-context.mjs:70`), so the line was a duplicate. I removed it and left a comment. `env.ts` still refuses a malformed or short value at boot. |
| `apps/web/src/modules/settings/components/avatar-card.tsx`: branch 96 | **Environment-only, but caused by a test bug.** `avatar.test.tsx` called `refuseNextPut(":59000/", 503)`, the default RustFS port. On a stack checkout the storage is on another port (59800 on stack 8), so nothing was refused and the test timed out. CI passed only because it uses 59000. | `refuseNextPut(status)` now targets the storage host from `S3_ENDPOINT`, through a `storageHost()` helper shared with `storageCors`. The 8 avatar tests pass on stack 8 (`bun run --cwd apps/web test:integration:files test/settings/avatar.test.tsx`). Before the change, the same test failed in both earlier runs. |

No coverage pragmas and no entries under Coverage exceptions.

## Final coverage run (with all the changes, just before committing)

```
@repo/api:coverage:  Test Files  40 passed (40)
@repo/api:coverage:       Tests  362 passed (362)
@repo/web:coverage:  Test Files  97 passed (97)
@repo/web:coverage:       Tests  567 passed (567)
@repo/notifications:coverage:  Test Files  7 passed (7)        (Stalwart suite included)
@repo/webhooks:coverage:  Test Files  6 passed (6)             (Stalwart suite included)
@repo/worker:coverage:  Test Files  6 passed (6)
@repo/db:coverage:  Test Files  5 passed (5)
@repo/contracts:coverage:  Test Files  8 passed (8)
@repo/ai:coverage: Required test coverage of 100.0% reached. Total coverage: 100.00%
@repo/ai:coverage: ================= 311 passed, 3 warnings in 225.88s (0:03:45) ==================
turbo exit 0

$ bun scripts/coverage.ts
524 source files, 19 reports: 0 below 100%.
merge exit 0
```

The merge used the UI report from step 1 and the scripts report from the baseline step 3.
Neither area changed after those runs.

## Other checks

- `bun run lint`: exit 0. knip first flagged `EMAIL_LIMITS` as an unused export, and I fixed
  it as described above.
- `bun run check-types`: 24 of 24 tasks succeeded.
- `bun run type-coverage` for apps/api, apps/web, apps/notifications, packages/db and
  packages/contracts: all ✔.
- `bun run test` for api, contracts, db and i18n: api 207, contracts 42 and i18n 11 tests
  passed. The hook-paths test still sees more than 20 named paths.
- `bun test scripts/claude-setup.test.ts scripts/ports.test.ts scripts/durations.test.ts`:
  89 pass, 0 fail.
- `bun run gen` was run after the error-code removal, and the generated files are committed
  (`apps/ai/openapi.json`, `apps/ai/app/contracts/*`, `packages/jobs/generated/*`,
  `packages/ai-client/src/generated/*`, `packages/i18n/messages/en.d.json.ts`).

## Concerns

- Removing `FRESH_SESSION_REQUIRED` changes `apps/ai/openapi.json`, since the error enum
  loses a value. That's a contract break for API compatibility. The PR title already
  declares a break with `!`, which the job accepts.
- The events catalog still lists `org.invitation_sent.v1`, along with its audit-log
  string. I left it alone on purpose: the catalog keeps names nothing emits any more
  (`org.api_key_*`, `stripe.*`, `webhook.*`), so stored audit rows still render.
- Local-only failures I didn't touch, all seen before:
  - `scripts/pre-push.test.ts` "the database steps" (stack-8 ports leak into the
    expected URLs).
  - A fingerprint test that timed out under load.
  - The UI and Director browser tests that time out when the machine is this busy.
- `scripts/ports.test.ts` lets tests fix ports "as data", which is how `:59000` slipped
  into the avatar test. I didn't tighten the check, because that's a guard-rail choice for
  the user.
- The publish and polish agents' files weren't touched: `apps/api` publish module,
  My media CutCard, template page, speech, landing services. The publish module uses
  only `inOrg`, so removing `fresh` and `orgAdmin` doesn't affect it.
