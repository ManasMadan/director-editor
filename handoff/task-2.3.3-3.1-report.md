# Tasks 2.3.3 + 3.1: sign-in with the demo account, and the demo account

Status: DONE_WITH_CONCERNS (concerns at the end; none block the feature).

(The worktree isolation refused writing to the shared checkout's
`.superpowers/sdd/...` path, so this report is at the same relative path inside the
worktree, uncommitted.)

Branch `worktree-agent-a478822236af80236`, rebased onto `origin/feat/mm/director-hackathon`
at `4512a71` (the landing page, 2.3.2, is already there and links to `/sign-in?demo=1`).

Commits (`4512a71..4d1040c`):

- `1f8c9af feat(api): add Director's shared demo account`
- `49222e2 feat(web): offer the demo account on the sign-in page`
- `0874d0e test(web): sign in with the demo account end to end`
- `4d1040c test(web): make the demo account once per e2e run`

## What changed and why

### The demo flag (db + contracts)

- `packages/db/prisma/migrations/20261018183000_demo_user`: `ALTER TABLE auth.user ADD COLUMN
  demo boolean NOT NULL DEFAULT false` (with `lock_timeout`). Expand only: a constant default
  doesn't rewrite the table, and the running release never reads it.
- **Why a column on auth.user, not a table:** it's one fact about one account, auth.user is
  already the API's alone, and registering it with better-auth as an additional field
  (`userAdditionalFields` in `packages/contracts/src/auth-settings.ts`, `type: "boolean",
  required: false, input: false`) puts it on every session's user with no extra query.
  `input: false` makes better-auth refuse it (400 `FIELD_NOT_ALLOWED`) in sign-up and
  `/update-user` bodies, and OAuth profiles skip it, so only the command sets it. A separate
  table would need its own RLS/grants and a lookup on every check. The timestamp is
  `183000` so it sorts after `20261018170000_director_seed_copies`.

### For task 2.4 (publishing): how to refuse the demo account

- `context.user.demo` is typed on every `authed`/`inOrg` procedure (better-auth infers it from
  `userAdditionalFields`). The publish procedure should do
  `if (context.user.demo) throw new AppError("DEMO_ACCOUNT_LOCKED")`.
- `DEMO_ACCOUNT_LOCKED` (403) is in `ERROR_CODES` and `AUTH_ERROR_CODES`, with `errors.*`
  ("The demo account can't do that. Create your own account to publish and change settings.")
  and `authErrors.*` messages. 2.4 can reuse it or add its own, friendlier code.
- The web app gets the same flag on `authClient.useSession().data.user.demo`, if 2.4 wants to
  hide or explain the publish button.
- The flag is never stale on a session: better-auth's `internalAdapter.updateUser` rewrites
  the user held by the account's sessions in Redis (checked by an integration test).
- If 2.4 checks in the Python service instead, app_ai has no SELECT on auth.user today; it
  would need a column grant `GRANT SELECT (id, demo) ON auth.user TO app_ai`.

### API

- `apps/api/src/env.ts`: `DEMO_PASSWORD` (optional, 8 to 128 characters, the password limits
  from contracts). `.env.example` (empty) and `docs/environment.md` updated.
- `system.info` (`packages/contracts/src/api/system.ts`, `apps/api/src/modules/system/system.router.ts`):
  a new nullable `demo: { email, password }`, set only when `DEMO_PASSWORD` is. Additive, so
  `/api/v1` stays compatible; `apps/api/openapi.json` regenerated.
- `apps/api/src/auth/demo.ts`: the policy. `DEMO_EMAIL = "demo@director.mmadan.in"`,
  `DEMO_LOCKED_PATHS` and `refuseForDemo`. (Split from demo-account.ts so auth-hooks and
  account-limits import it without a dependency cycle through `auth.module`.)
- `apps/api/src/auth/demo-account.ts` + `apps/api/src/director-demo-account.ts`: the command.
  `bun run --filter @repo/api director:demo-account [--force] [--reset]` (also
  `bun run director:demo-account -- --force` through turbo; deployed:
  `node dist/director-demo-account.mjs`). It refuses outside production without `--force`,
  refuses without `DEMO_PASSWORD`, and refuses options it doesn't know.
  - First run: it creates the user through better-auth's own `internalAdapter.createUser`
    (verified, `demo: true`), so the sign-up hook makes the personal workspace and copies the
    seeds (`copySeedTemplates`) in its transaction. Then it links a credential account with
    the hashed `DEMO_PASSWORD`. No verification email goes out.
  - Run again: same user. It sets verified and the flag again, sets the password (so rotating
    `DEMO_PASSWORD` and re-running works), re-links a credential account if one went missing,
    and copies any missing seed. **It doesn't touch the demo's own indexed plan, takes or cuts.**
  - `--reset`: deletes every workspace the demo account is in (a workspace has one member,
    `WORKSPACE_MEMBER_LIMIT = 1`, so they're all its own), with an `org.deleted.v1` event each,
    then its sessions (Redis too) and the user. Tenant tables cascade from auth.organization.
    Then it creates the account fresh. **What --reset clears:** the account and its id, its
    sessions, its personal workspace and everything in it: its own indexed Short (which gives
    back its one index), its takes, cuts and their file rows, its likes and saves. It comes
    back with only the 6 seeds.
  - If the personal workspace is gone, the command says so and tells you to run `--reset`.
- **Locking the shared account (a decision the brief didn't spell out):** every judge signs
  in to the same account, so one judge could change its password, turn on two-step
  verification, delete it or sign everyone else out, and the next judge's one-click sign-in
  would fail. `requestHooks.before` (`apps/api/src/auth/auth-hooks.ts`) refuses
  `/change-password`, `/delete-user`, `/two-factor/enable`, `/link-social`, `/revoke-session`,
  `/revoke-sessions` and `/revoke-other-sessions` for a session whose user has `demo`
  (403 `DEMO_ACCOUNT_LOCKED`). Email change and password reset already need codes sent to the
  demo's mailbox. Profile edits (name, timezone) stay allowed: the web app records the
  browser's timezone through `/update-user`.
- **The per-account sign-in limit (also a decision):** `/sign-in/email` allowed 10 attempts per
  account per 15 minutes, so a dozen judges, or anyone spamming, would lock the demo out for
  everyone. `apps/api/src/auth/account-limits.ts` now has an `exempt` list on a limit, with the
  demo email exempt for sign-in only. The password is public, so there's nothing to guess. The
  per-IP limit (5 a minute) still applies.
- `apps/api/test/harness.ts`: `command`, `PRODUCTION` and `refusingExit` moved here from
  seed.integration.test.ts so both command test files share them (`command` now takes argv),
  and `DEMO_PASSWORD` is empty by default like the other optional features.

### Web

- `apps/web/src/modules/auth/components/demo-account.tsx` (`DemoAccountOffer`), used at the
  top of the sign-in form (`pages/sign-in.tsx`). With `system.info.demo` set it shows a region
  titled "Try Director with the demo account" with the email and password in plain sight and a
  "Use demo account" button that fills the form (`form.reset(demo)`). With `?demo=1` it fills
  the form once the account is known, only once, so a refetch never overwrites what the person
  typed. Until system.info answers it shows `GeminiLoader` labelled "Getting the demo
  account…". The Google button was already there behind `features.google`; it's unchanged
  and still tested. Every string is in `packages/i18n` (`auth.demo.*`).

### Tests, e2e and the e2e runner

- `apps/web/test/demo.ts` is the demo credentials the browser tests' full API offers
  (`global-setup.ts` sets `DEMO_PASSWORD` on the full API, empty on the bare one).
- `apps/web/e2e/demo.spec.ts` makes the account by running the real command
  (`bun run --filter @repo/api director:demo-account --force`) in `beforeAll`, serially
  (two workers on a fresh database would both try to create it). Then it signs in from the
  card and from `?demo=1`, and both land on `/library`, with axe on the sign-in page.
- `scripts/e2e.ts`: `bun run test:e2e` gives the stack a throwaway `DEMO_PASSWORD`
  (`newSecret()`) when the checkout's `.env` has none, and hands the same value to every
  service and suite. So CI needs no workflow change, and a local run without one works.
  Against `bun dev` (`bun run --cwd apps/web test:e2e`), the `.env` needs `DEMO_PASSWORD`.
  The spec fails with the command's "DEMO_PASSWORD isn't set" otherwise.
- Docs: `docs/director.md` "The demo account" (the command, re-run vs --reset, the locks),
  `docs/environment.md` (`DEMO_PASSWORD`).
- Local: I set `DEMO_PASSWORD` in this worktree's `.env` with `bun run env:set` (generated,
  not printed).

## TDD evidence (the failing runs first)

- Unit, `account-limits.test.ts`, before the exemption:
  `Tests 1 failed | 3 passed (4)` ("is missing for the demo account's sign-in"); after: `4 passed`.
- Scripts, `scripts/e2e.test.ts`, before the e2e change:
  `error: Received value must be a string: undefined … 13 pass 1 fail`; after: `14 pass 0 fail`.
- Web, `test/auth/sign-in.test.tsx` + `sign-in.features-off.test.tsx` against the old sign-in
  page: `Tests 3 failed | 8 passed (11)` (the card, `?demo=1` and the loader tests: "Cannot
  find element … 'Try Director with the demo account'"); with the new page: `11 passed (11)`.
- API integration (`test/demo-account.integration.test.ts`): written before the command, but
  its first run was after it was written, so there's no red run to show. Its first runs failed
  on test plumbing (app_ai has no DELETE on director_plan: the "lost seed" setup now runs as
  the superuser), then `15 passed`. The file now has 16 tests.

## Commands and output tails

- `bun run lint`: every step ✔ (biome, lint:boundaries "no dependency violations found",
  unused, markers, patterns, suppressions, prisma, actionlint, zizmor, shellcheck, hadolint,
  tflint, renovate, turbo lint). Biome's one warning is the existing one in
  `scripts/image-scan.test.ts`.
- `bun run check-types`: `Tasks: 24 successful, 24 total` (after the rebase).
- `bun run type-coverage`: every workspace ✔.
- `bun run test`: `Tasks: 22 successful, 22 total`.
- `bun run gen`: `Tasks: 6 successful`, no drift after the rebase (`git status` clean).
- `bun run db:lint`: `Found 0 issues in 3 files`. `bun run --filter @repo/db drift`: `No drift
  between migrations, schema and database.`
- `bun run --filter @repo/api test:integration -- test/api.integration.test.ts
  test/seed.integration.test.ts test/features-off.integration.test.ts
  test/demo-account.integration.test.ts`: `Test Files 4 passed (4) / Tests 83 passed | 13
  skipped (96)`. The skipped ones are the `files`-tagged tests.
- `bun run --filter @repo/api coverage` (every api suite, with RustFS and ClamAV up):
  `Tests 1 failed | 332 passed (333)`. The failure is "account security > a failed change
  sends no alert" timing out waiting for a sign-up OTP (17.8s under load). It passed in the
  rerun above, and its path (sign-up) isn't one the change touches.
  `bun scripts/coverage.ts apps/api`: every file I touched is at 100%. What it lists below
  100% (`account-limits.ts` lines 154/157 in `createEmailLimits.invitation`, `auth-plugins.ts`,
  `auth.ts:129`, `rpc/procedures.ts`, `scripts/openapi.ts`) isn't in my diff and is covered by
  other suites in the merged run.
- `bun run --filter @repo/web test:integration` (whole suite): `Test Files 54 passed | 1
  skipped (55) / Tests 330 passed | 17 skipped (347)`.
- `bun run --filter @repo/web coverage && bun scripts/coverage.ts apps/web`: `sign-in.tsx` and
  `demo-account.tsx` at 100%. The run had 4 timing failures in unrelated files (two-factor,
  shoot, avatar), which passed in the integration run just before. The files it lists below
  100% are those same three (the branches their failed tests would have covered) and
  `scripts/copy-static.ts`.
- `bun test ./scripts/ ./.claude/hooks/`: `971 pass, 3 fail` before committing, and after
  committing `bun test ./scripts/` gave `793 pass, 2 fail`. The 2 are
  `pre-push.test.ts` "the database steps …", which expect port 55432 and get my stack's 56032
  (from `bun run setup --stack 6`). That's the environment, not this change. The third, the web
  image's "type-checks only committed files", only failed while the new files were untracked,
  and passes once committed.
- `bun run --filter @repo/ai test`: `90 passed, 64 deselected`.
- `bun run test:e2e --app web e2e/demo.spec.ts`, after deleting the demo user from my stack's
  database so the first run creates it: `Created the demo account demo@director.mmadan.in.` once,
  `✓ signs in with the demo account's card and lands in the library`,
  `✓ the landing page's link fills the form with it`, `2 passed`, `exit=0`.
- Locally: `bun run --filter @repo/api director:demo-account --force` → `Created …`, again →
  `Updated …: copied 0 missing seeded templates, and kept its own Shorts and takes.`, and
  without `--force` → `The demo account is for production; pass --force …` (exit 1).

## Concerns and notes for the controller

1. **Production setup:** set `DEMO_PASSWORD` in `api.sops.yaml`, deploy, then run
   `node dist/director-demo-account.mjs` once in the api image (no `--force` in production).
   Re-run it after rotating the password. Until it has run, the sign-in page shows the
   credentials but sign-in fails, because the account doesn't exist yet.
2. The per-IP sign-in limit (5 a minute on `/sign-in/email`) still applies. Judges sharing one
   venue NAT could hit it if more than 5 sign in within a minute. I left it alone because it's
   the brute-force guard for every account.
3. I locked account-changing auth endpoints and exempted the demo from the per-account sign-in
   limit. The brief didn't ask for either, but without them one judge can lock the demo out for
   everyone (reasons above). Passkeys and profile edits stay allowed.
4. The command isn't safe to run twice at the same moment (two creates would race on the
   unique email). That's fine for a one-off command; the e2e spec runs serially for the same
   reason.
5. `DEMO_ACCOUNT_LOCKED` sits in both `ERROR_CODES` (for 2.4's oRPC refusal) and
   `AUTH_ERROR_CODES` (for the auth endpoints). 2.4 may prefer its own code with a
   publish-specific message.
6. The API's test Valkey database for the new file is 3 (inside "the api's files 1 to 5" in
   docs/testing.md, currently unused); `scripts/redis-databases.test.ts` passed.
7. Edits outside the feature folders: `biome.jsonc` (the new entry file added to the noConsole
   list next to `director-seed-workspaces.ts`), `turbo.json` and the root `package.json`
   (the `director:demo-account` task, like seed-workspaces), `scripts/e2e.ts`.
8. I stopped my stack's services (stack 6) with `bun run db:down` when I finished.

## Fix round 1 (Opus security review)

Commit `77e561e fix(api): keep the demo account's workspace, devices and name out of
judges' hands` (range now `4512a71..77e561e`). I wrote every test below first and ran it red:
`Tests 10 failed | 28 passed` across demo-account, features-off and api.integration. The two
`/link-social` and `/revoke-session` cases passed at once, since those paths were already
locked. After the fix the same files went green.

| # | Change | Test |
|---|---|---|
| 1 (important) | `apps/api/src/auth/demo.ts:45-48`: `/organization/create`, `/organization/update`, `/organization/leave` and `/organization/delete` are in `DEMO_LOCKED_PATHS`. `apps/api/src/auth/auth-plugins.ts:149`: `beforeDeleteOrganization` refuses any `personal-` workspace for everyone (403 `FORBIDDEN`); account deletion and `--reset` delete through the database, so they still work. | `apps/api/test/demo-account.integration.test.ts:290` (it.each, the four org paths: 403 `DEMO_ACCOUNT_LOCKED`, and the workspace, its name and the membership are unchanged); `apps/api/test/api.integration.test.ts:238` "can't delete its personal workspace" (any user: 403, workspace still there). The next test in that file, which sets up an account with no workspace, now deletes it through the database. |
| 2 (important) | `apps/api/src/auth/demo.ts:85` `ownSessionOnly` + `apps/api/src/auth/auth-hooks.ts:127`: the after hook replaces `/list-sessions`'s answer for a demo session with just the session asking. Anyone else's list is untouched. With revoke locked, nobody signed in as the demo can see or end anyone else's session, so the settings card needs no change. | `demo-account.integration.test.ts:328` (two demo sessions: the list holds only the current one); unit `apps/api/src/auth/demo.test.ts` |
| 3 (minor) | `demo.ts:73` `refuseDemoProfileChange`, called in the user `update.before` hook for `/update-user` (`auth-hooks.ts:215`): the demo may change only `locale`, `timezone` (and better-auth's `updatedAt`). Other users are unaffected. `setAvatar`: `apps/api/src/modules/user/avatar.service.ts:31` throws `DEMO_ACCOUNT_LOCKED` (the service now takes the user, `user.router.ts`), declared in `packages/contracts/src/api/user.ts:12` (openapi regenerated). The command's update path sets `name: DEMO_NAME` (`apps/api/src/auth/demo-account.ts:113`) and the personal workspace's name (`:127`). `/organization/update` is locked by item 1. | `demo-account.integration.test.ts:311` (rename 403, setAvatar `DEMO_ACCOUNT_LOCKED`, timezone/locale 200, name unchanged); `:216` (re-run puts back both names); unit `demo.test.ts` |
| 4 (minor) | `apps/api/src/auth/hook-paths.test.ts:34`: every `DEMO_LOCKED_PATHS` entry must be one of `auth.api`'s endpoint paths. | That test; plus `/link-social` and `/revoke-session` added to the integration it.each (`demo-account.integration.test.ts:290`) |
| 5 (minor) | `apps/api/src/auth/account-limits.ts:27,36,67,76`: the sign-in limit carries `exemptsDemo`, and `accountKey`/`createAccountLimits` take the demo address only when it's offered. `apps/api/src/auth/auth-context.ts:64` passes `DEMO_EMAIL` only when `DEMO_PASSWORD` is set. | `apps/api/test/features-off.integration.test.ts:49` (no DEMO_PASSWORD: the 11th attempt at the demo address gets 429); `demo-account.integration.test.ts:268` (DEMO_PASSWORD set: 12 sign-ins pass); unit `account-limits.test.ts` (both cases) |
| 6 (minor) | `apps/api/src/auth/demo-account.ts:152`: `--reset` deletes only workspaces where `members: { some: { userId }, every: { userId } }`. A shared one just loses the membership, with the account. | `demo-account.integration.test.ts:232` (a workspace the demo shares with someone else survives `--reset`, with its other member) |

Also: `docs/director.md` "The demo account" now lists the new locks, the device list, the
condition on the sign-in exemption, that personal workspaces can't be deleted through the API,
the name restore, and `--reset`'s sole-member rule. I moved `refuseForDemo`'s unit test into
the new `demo.test.ts`. The after hook now returns explicitly on every path, since TypeScript's
noImplicitReturns needs that once one path returns a response.

Checks (stack 6, stopped after):

- `bun run --filter @repo/api test:integration -- test/demo-account.integration.test.ts
  test/features-off.integration.test.ts test/api.integration.test.ts test/seed.integration.test.ts`:
  `Test Files 4 passed (4) / Tests 95 passed | 13 skipped (108)`.
- `bun run --filter @repo/api test:integration` (every non-files suite): `Test Files 11 passed
  (11) / Tests 136 passed | 13 skipped (149)`.
- `bun run --filter @repo/api test:integration:files` (the avatar tests, after the service's
  signature change): `13 passed`.
- `bun run --filter @repo/api test`: `Tests 200 passed (200)`; contracts `35 passed`, i18n
  `11 passed`.
- `bun run lint`: every step ✔. `bun run check-types`: `Tasks: 24 successful, 24 total`.
  `bun run gen`: openapi.json regenerated and committed.
