# Director v2, slice 7 review: demo guests, landing, Quick start, read-only post

Branch `origin/feat/mm/v2-demo-guests` (1e683f8), 7 commits, 53 files. Its merge base with
master is **ae43b93** (#12), not 1551ba1 (1551ba1 is ae43b93's parent). Master has moved
past fd9ef09 to **581ab3a** (a deploy commit). I checked the merge against both.

I reviewed the code statically, mostly from a `git archive` of the branch, plus the
installed better-auth 1.7.6 (the version in the branch's `bun.lock`). I didn't run any
tests, so the implementer's "passing" claims are still unverified.

## Verdicts

| # | Check | Verdict |
|---|---|---|
| 1 | Security of the guest sign-in | **Needs fixes**: two Important issues (a session can outlive the day; nothing stops a bot from filling the cap) |
| 2 | Cleanup job | **Pass** |
| 3 | Migration | **Pass** |
| 4 | Spend exposure | **Needs fixes**: each guest gets its own allowance, nothing limits the demo's total spend, and the 300 cap isn't atomic |
| 5 | i18n, a11y, tests | **Pass, with Minor issues**: the hero loops forever without a pause (WCAG 2.2.2), and no test drops the dont_remember cookie |
| 6 | Merge with master | **Textually clean, one semantic conflict (Important)**: two suites share Valkey database 29 |
| 7 | Commit messages | **Minor**: `wip(api)` fails commitlint. No AI mentions |

---

## 1. Security of the guest sign-in

What holds:

- **No privilege escalation through input.** `demo` and `guestUntil` are `input: false`
  (`packages/contracts/src/auth-settings.ts`). Only `internalAdapter.createUser` sets them
  (`apps/api/src/auth/guest.ts:89-99`). Tests show that sign-up and `/update-user` refuse
  both (`apps/api/test/demo-guests.integration.test.ts:195-208`). `timezone` and `locale`
  still go through `newUserFields`' normalisation (`apps/api/src/auth/auth-hooks.ts:32-53`).
- **The existing demo restrictions apply**, because guests carry `demo = true`:
  - `DEMO_LOCKED_PATHS` (`apps/api/src/auth/demo.ts:45-59`) covers passkey registration,
    link-social, delete-user, 2FA, session revoking and workspace changes. The hook is at
    `auth-hooks.ts:102-104`.
  - Name and avatar changes are refused (`demo.ts:87-94`, `modules/user/avatar.service.ts:30`).
  - Publishing is refused (`modules/publish/publish.service.ts:192-193`).
  - Each guest sees only its own sessions (`ownSessionOnly`).
  - Tests cover these at `demo-guests.integration.test.ts:168-193`.
- **A guest's account can't be taken over or kept.** Its address is on `.invalid` and it
  has no password row. A change of email needs a code from the current address
  (`auth-plugins.ts:45`, `verifyCurrentEmail: true`). Google sign-in creates a separate
  user, and linking is locked.
- **The per-address limit is sound.** The plugin's `rateLimit` (`guest.ts:116-122`) uses
  better-auth's limiter, stored in Valkey (`auth.ts:57-59`). The address comes from
  `request.ip`, which the API rewrites into `x-forwarded-for` (`auth.routes.ts:50-53`), so a
  client can't spoof it.
- **Guests can't reach each other's workspaces.** Each guest gets its own user and
  workspace, and `set-active` refuses another guest's workspace
  (`demo-guests.integration.test.ts:153-164`).

Issues: **I1** (a session can outlive 24 hours) and **I2** (no captcha, and a bot can fill
the cap), both below.

## 2. Cleanup job: pass

- **It deletes all of a guest's data.** The purge
  (`packages/db/prisma/migrations/20261018200000_demo_guests/migration.sql:28-55`) deletes
  each workspace that only expired guests belong to (lines 42-50). Plans, takes, cuts and
  `ai.ai_usage` cascade from the organization. Then it deletes the user (line 52), and
  sessions, accounts, members and `files.file` cascade from that.
  - Every FK to `auth.user` is `Cascade`, or `SetNull` for `director_plan.created_by`, so
    no RESTRICT blocks the delete.
- **It deletes the storage objects.** The `files.file` delete trigger queues `quarantine/`
  and `files/` keys (`20260929120000_files/migration.sql:59-72`). The worker then runs
  files cleanup in the same task (`apps/worker/src/maintenance/maintenance.processor.ts:164-177`).
  - Takes and cuts are `files.file` rows (`schema/ai.prisma:73-74, 111-112`), so their
    objects are covered.
  - `director_plan.audio_key` is `audio/{video_id}.m4a`, shared across workspaces
    (`apps/ai/app/audio.py:78`). Leaving it in place is correct.
- **RLS.** `auth.user`, `auth.organization` and `auth.member` have no RLS. The cascades
  into the RLS tables (and into `files.file`, which forces RLS) run as referential-integrity
  actions, which bypass row security. The function is SECURITY DEFINER with a pinned
  `search_path`. This follows the precedent of `auth.purge_expired`.
- **Idempotent.** It only selects `guest_until <= now()`, uses `FOR UPDATE SKIP LOCKED`,
  and loops in batches of 100 until a batch comes back short. The worker test runs it a
  second time and expects 0 (`apps/worker/test/worker.integration.test.ts:538-599`, 101
  guests).
- **It can't touch non-guests.** Rows need `guest_until IS NOT NULL`, which only the guest
  endpoint sets. A workspace is deleted only when it has no member outside the expired set
  (`NOT EXISTS ... <> ALL`). The test keeps the live guest and the member.
- One gap: no test covers a workspace shared with a non-guest. That can't happen today
  (`WORKSPACE_MEMBER_LIMIT = 1`), so the guard is only defence in depth. Minor M6.

## 3. Migration: pass

- Expand-only: one nullable `TIMESTAMPTZ(3)` column with no default (line 11), with
  `lock_timeout` set (line 1). The schema matches `schema/auth.prisma`.
- Grants:
  - `REVOKE EXECUTE ... FROM PUBLIC` and `GRANT EXECUTE ... TO app_worker` (lines 57-59).
  - app_api already has table-level DML on auth (`init/migration.sql:146`), so the new
    column needs no new grant.
  - The worker test proves app_api can't run the function and app_worker can't delete
    users.
- No index on `guest_until` is acceptable for now. It's justified in the report:
  `auth.user` is small, and an index would need its own `CONCURRENTLY` migration.

## 4. Spend exposure

- **Per-guest allowance.** Yes, each guest gets its own. The AI service's budget is per
  workspace: `AI_MONTHLY_TOKENS_PER_ORG`, 2,000,000 by default (`apps/ai/app/settings.py:104`).
  Production doesn't override it.
  - Reservations within a workspace are atomic: `pg_advisory_xact_lock` per org, then sum
    and insert (`apps/ai/app/usage.py:52-75`).
  - Gemini Live calls are limited per user, at 20 an hour (`apps/api/src/server.ts:109-114`)
    of up to 10 minutes each (`live.gateway.ts:35`).
  - The shared account had one of each for everyone. Guests multiply that by up to
    `DEMO_GUEST_LIMIT` (300). Because the cap frees up as guests expire, it's up to 300
    times a day.
- **Is the 300 cap enforced atomically?** No. `refuseWhenFull` counts and then
  `createUser` inserts, with no lock or reservation (`guest.ts:55-64, 82-99`). The code
  comment says "one over doesn't matter" (lines 24-25). In practice, the overshoot is as
  large as the number of concurrent requests: a burst from N addresses (5 each) all pass
  the count before the first commit.

Issue: **I3**, below.

## 5. i18n, a11y and tests

- **i18n.** Every new string is in `packages/i18n/messages/en.json`: hero, steps, Cloud,
  demo card, fallback, `DEMO_GUESTS_FULL`, `readOnly.*`, `quickStart.*`, and
  `auth.guest.name`, which the API reads through `@repo/i18n` (`guest.ts:46, 87`). The
  only literal is the decorative "✓", which is `aria-hidden`. The copy matches spec 5.1,
  5.2 and 5.5. "Pick a Short" in place of "Pick or describe" is documented.
- **a11y.** In good shape:
  - The demo card is a labelled region, and failures use `role="alert"`.
  - The hero's exchange is an `<ol>` with sr-only speaker labels, and the REC indicator is
    hidden from screen readers.
  - The Quick start link has an accessible name, `alt=""` and a focus-visible ring.
  - Reduced motion shows the end state.

  Two findings: M1 (the loop never stops) and M3 (the reading order of the shot card).
- **Tests** check real behaviour against the real API, with no mocks of our own code:
  - the API integration suite, 15 tests;
  - the worker purge with real storage;
  - browser tests on the full API with guests on (`apps/web/test/global-setup.ts`), with a
    random `x-forwarded-for` per page, so they don't trip the per-address limit;
  - the client plugin's signal.

  Gaps: no test drops the `dont_remember` cookie (part of I1), and the e2e suite never
  takes the guest path (`e2e/demo.spec.ts` runs with guests off).
- **Coverage.** I didn't re-run `test:coverage`. Reading the code, every new branch is
  exercised:
  - `GuestOffer`: idle, starting, failed with and without a shared account;
  - `DemoOffer`: guests off, and `system.info` down;
  - `ReadOnlyPost`: loader, success, failed;
  - `quickStartOf`: found, not ready, empty;
  - the worker loop: one batch and more than one;
  - the switch off: `features-off`, 404.

## 6. Merge with master

- `git merge-tree --write-tree origin/master origin/feat/mm/v2-demo-guests` exits 0 (tree
  47ccfcf). Against fd9ef09 it's also clean (61fd96d).
- Both sides touched `apps/api/test/harness.ts`, `publish.integration.test.ts`,
  `production/stack.yaml`, `docs/director.md` and `docs/environment.md`. All merge
  textually.
- **Semantic conflict:** see I4.
- Also after the merge: master's activity log (`auth-activity.ts`, `signInMethod`) records
  every `demo` user as method `"demo"`. Guest sign-ups and sign-ins will show as "demo",
  not as guests. That's acceptable, but worth knowing.

## 7. Commit messages

- Six of the seven are Conventional Commits with valid scopes: `api`, `worker`, `web`,
  `repo`, `infra`.
- There are no mentions of AI, Claude, co-authors or "generated". The author is Manas
  Madan <manasmadan08@gmail.com> throughout.
- `a0b5faf wip(api): ...`: `wip` isn't in `@commitlint/config-conventional`'s types. See M7.

---

## Issues

### Critical

None.

### Important

**I1. A guest's session can outlive 24 hours if the client drops the `dont_remember` cookie.**

`apps/api/src/auth/guest.ts:100-111` relies on better-auth's "don't remember me" cookie to
stop the session being refreshed. In better-auth 1.7.6, the refresh is skipped only when
that signed cookie arrives with the request (`node_modules/better-auth/dist/api/routes/session.mjs:51, 169`).

Without the cookie, the refresh test (`session.mjs:178-183`) is
`expiresAt - expiresIn(7d) + updateAge(1d) <= now`. For a session ending in 1 day, that's
true at once. So the first `get-session` sent with only `session_token` (curl, or the
cookie deleted in devtools) pushes `expiresAt` to now + 7 days, sliding from there.

The purge later deletes the Postgres rows. But session lookups read Valkey first
(`auth.ts:148`; `internal-adapter.mjs:321-341`), and the SQL purge never removes the Valkey
key. So the session, with its cached user, stays valid for up to 7 days after the guest is
gone. The guest also keeps full use of its workspace until the next hourly purge.

Once its workspace is deleted, a zombie session can do very little (writes fail their
foreign keys). But it breaks the slice's "sessions can't outlive 24 hours" invariant. The
test at `demo-guests.integration.test.ts:122-130` sends both cookies, so it doesn't catch
this.

*Fix:* enforce the limit on the server. For example, add a `databaseHooks.session.update.before`
that clamps any new `expiresAt` to the user's `guestUntil`. The hook can read it from
`ctx.context.session.user`, or look it up. Because better-auth computes the Valkey TTL from
`expiresAt`, clamping also keeps the Valkey key from outliving the purge. Then add an
integration test that calls `/get-session` with only the session cookie and expects
`expiresAt` unchanged.

**I2. No captcha on the guest sign-in, so a bot can fill the cap, and a full cap puts real
judges back on the shared account.**

Captcha covers only sign-up and the OTP endpoints (`apps/api/src/auth/auth-plugins.ts:186-193`).
`/sign-in/guest` takes no proof of a human.

With 5 guests per address per hour, about 60 addresses fill 300 guests in an hour. Every
real judge after that gets `DEMO_GUESTS_FULL` and falls back to the shared account. The
shared account shows everyone's footage, which is exactly what slice 7's acceptance
criterion forbids ("A second person on another phone never sees the first one's footage").
Each bot guest also holds a full AI allowance (I3).

*Fix:* when `features.captcha` is on, add `/sign-in/guest` to the captcha plugin's
`endpoints`, and render Turnstile in invisible or managed mode on the demo card, so it
stays one tap. At minimum, lower `DEMO_GUEST_LIMIT` in production (see I3) and note the
trade-off in `docs/director.md`.

**I3. The demo's AI spend has no overall ceiling, and the 300 cap isn't atomic.**

Each guest is a new workspace with its own 2M-token monthly allowance (`apps/ai/app/settings.py:104`)
and its own 20 live calls an hour (`apps/api/src/server.ts:109-114`). The only bound across
guests is `DEMO_GUEST_LIMIT`, 300 in production by default. That cap is checked and then
inserted without serialisation (`guest.ts:55-64, 82`), so a concurrent burst goes past it
by the size of the burst.

Production runs on $300 of GCP credits. The worst case of 300 guests a day, each with live
calls and 2M tokens, is far above the shared account's single allowance.

The purge also deletes guests' `ai.ai_usage` rows with their workspace, so cost reporting
loses what guests spent.

*Fix:*
- Make the cap atomic: a Valkey sorted set of guest expiries, trimmed and counted and
  added to in one Lua script, or a `pg_advisory_xact_lock` around count-and-insert.
- Give the demo a shared ceiling: a demo-wide token budget key, or a much smaller
  per-guest monthly allowance and live-call limit for `demo` users.
- Set a production `DEMO_GUEST_LIMIT` sized to the credits (for example 30 to 50).
- Consider recording guest usage somewhere the purge doesn't cascade to, such as the
  BigQuery events.

**I4. After the merge, two suites share Valkey database 29.**

Master's `apps/api/test/activity.integration.test.ts:34` and this branch's
`apps/api/test/demo-guests.integration.test.ts:21` both call `startApi(29, ...)`. The API
harness flushes its database. So:
- `scripts/redis-databases.test.ts` (the "each belong to one package, and to one file
  where that file flushes it" test) will fail on the merged tree;
- if both suites run in parallel, they flush each other's sessions and queues.

*Fix:* when rebasing, move the guest suite to a free database. 22, 23, 27, 30 and 31 are
free (docker-compose has 32). Update `docs/testing.md:161` to match.

### Minor

**M1. The hero loops forever with no way to pause it** (`apps/web/src/modules/marketing/landing.css:216-232`,
`infinite`). For visitors without reduced motion, a 10-second auto-playing loop beside
other content needs a pause or stop mechanism (WCAG 2.2.2, Level A). Spec 14 sets WCAG 2.2
AA as the bar. *Fix:* a small pause button, or stop after a couple of loops and pause on
hover or focus.

**M2. Members of the demo briefly see the Publish button.** `PublishButton` decides
read-only from `authClient.useSession().data?.user.demo`
(`apps/web/src/modules/director/components/publish-sheet.tsx:404`). While the session
loads, a demo user sees "Publish", and opening it shows the publish form until the API
refuses the upload. *Fix:* render the trigger only once the session has resolved.

**M3. The shot card is read out of order.** In `hero-chat.tsx:31-41`, the card's after
state is read before the exchange that causes it. *Fix:* hide the card from screen readers
too (the exchange already says it), or move it after the `<ol>` in DOM order.

**M4. Demo users on a shared network fall back to the shared account.** Five guests per
address per hour (`DEMO_GUESTS_PER_ADDRESS`) means a judging room or office behind one NAT
sends its sixth person to the shared account. That's fine for remote judging; raise it via
env for an in-person event.

**M5. The shared fallback account keeps footage indefinitely.** Spec 18 sets retention at
"24 hours for the demo", but nothing deletes the shared account's footage after a day. It
also still accumulates. *Fix:* a follow-up, either a periodic reset of the shared account
or a 24-hour purge of its takes and cuts.

**M6. Gaps in test and spec coverage:**
- No e2e covers the guest path; e2e stacks run with guests off.
- The purge test doesn't cover a shared workspace surviving.
- Spec 5.2's "Google first ... Continue with Google, to post to your channel" isn't in
  this branch. It's not listed in slice 7's deliverables, so it may belong elsewhere.

**M7. `a0b5faf wip(api): ...` fails commitlint's type-enum.** If the branch is merged with
its commits rather than squashed, reword it to `feat(api): ...`. If it's squashed under a
conventional PR title, it doesn't matter.

---

## Result

**Needs fixes.** Before merging: I1 (enforce the guest's session end on the server, and
test it), I3 together with I2 (an atomic cap, a demo-wide spend ceiling or a smaller
per-guest allowance, a production `DEMO_GUEST_LIMIT` sized to the credits, and preferably
Turnstile on the guest sign-in), and I4 (renumber the Valkey database when rebasing on
master). The cleanup job, the migration, i18n and the tests are solid. The Minor issues can
follow.

---

# Re-review (fix round, tip 05a578f)

The branch is rebased onto master 581ab3a. The fixes are 5e1dc1f (server) and 05a578f
(web and e2e). 1fefa0c is the squashed original.

I reviewed `git diff 1fefa0c..05a578f` and the parts of the migration and `guest.ts` they
replaced. I checked the session clamp against better-auth 1.7.6's `updateWithHooks` and
`updateSession`. I ran no tests. The implementer's results (API integration 170, worker
23+19, AI 90, the browser files) are unverified, and the e2e specs weren't run by anyone.

## Verdicts on the earlier issues

**I1: a session outliving its day. Fixed.**

- `sessionHooks.update.before` (`apps/api/src/auth/auth-hooks.ts:272-277`) calls
  `clampToGuestDay` (`apps/api/src/auth/guest.ts:103-112`). better-auth runs the
  update-before hook before its Valkey write and passes the hook's data to it
  (`internal-adapter.mjs:410-449`, `with-hooks.mjs:44-67`). So both the Postgres row and
  the Valkey TTL end at `guestUntil`.
- `ctx.context.session` is set before the refresh (`session.mjs:153`). The cached user's
  `guestUntil` arrives as a string, which `z.coerce.date()` handles. A unit test covers it.
- The purge now returns the session tokens, and the worker deletes `auth:<token>` and
  `auth:active-sessions-<id>` (`maintenance.processor.ts:176-189`). The API and worker get
  the same `REDIS_URL` secret (`deploy/charts/stack/templates/_helpers.tpl:165-170`).
- Tests:
  - `demo-guests.integration.test.ts` drops `dont_remember` and asserts the expiry and
    TTL stay within the day;
  - the worker test asserts the expired guest's keys are gone and the live guest's key
    stays.
- One side effect: a client that drops the cookie now triggers a session write on every
  request, because the session always looks due for a refresh. That's harmless.

**I2: no captcha on the guest sign-in. Fixed on the API. The web side adds a new problem, N1.**

- `/sign-in/guest` is in Turnstile's endpoints while guests are on
  (`auth-plugins.ts:191-196`). The captcha suite asserts a 400 without a token.
- The web sends the token from an `interaction-only` widget (`demo-account.tsx:59-104`,
  `captcha.tsx:93`). The button waits for `captcha.ready`, `?demo=1` waits for the token,
  and the token is reset after a failure.

**I3: spend. Fixed.**

- **Atomic cap.** One Lua script trims, counts and adds (`guest.ts:59-95`) on a sorted
  set scored by expiry. The test fires 8 concurrent sign-ins against a cap of 4 and gets
  exactly 4.
- **Production limit.** Production sets `DEMO_GUEST_LIMIT: "50"`, with a chart test.
- **Guest token allowance.** 300k tokens a month, in `reserve`, under the same advisory
  lock (`apps/ai/app/usage.py:63-88`). The check is the SECURITY DEFINER
  `ai.demo_guest_workspace`, granted to `app_ai` only (migration lines 123-132).
- **Guest live calls.** 6 an hour, through a separate limiter (`server.ts:126-132`). The
  guest is identified by `guestUntil != null` (`rpc/procedures.ts:213`).
- **Cost record.** Guests' `ai.usage` is folded into `ai.demo_usage` before their
  workspaces go (migration 69-77). The table has no `org_id`, so it falls outside the
  forced-RLS check, and no app role is granted access to it. That's correct.
- Residual risk, not blocking: a guest still has up to 6 × 10 minutes of Gemini Live an
  hour for its whole day, and up to 50 guests. A billing alert on the project is the
  cheap safeguard.

**I4: shared Valkey database 29. Fixed.** The guest suite uses `startApi(30)`, and
`docs/testing.md:161` lists 29 for the activity log and 30 for guests.
`git merge-tree origin/master 05a578f` is clean.

**Minor issues:**

- **M2 (Publish flash). Fixed.** The trigger isn't rendered while
  `useSession().isPending` (`publish-sheet.tsx:404-425`).
- **M3 (shot card order). Fixed.** The card comes after the `<ol>` in the DOM, and a
  server-render test asserts the order.
- **M4 (shared network). Fixed.** `DEMO_GUESTS_PER_ADDRESS` defaults to 20.
- **M5 (shared account footage). Fixed.** `files.purge_demo_footage` deletes the shared
  account's take and cut files older than a day (migration 101-117). The migrator policy
  on `files.file` covers only that account's rows. The test keeps a recent file and
  another member's file.
- **M6 (e2e and Google first).** Done, but the e2e isn't run.
  - `e2e/demo-guests.spec.ts`: two devices get separate guests and libraries.
  - `demo.spec.ts` covers the shared account as the fallback.
  - The sign-in page shows "Continue with Google, to post to your channel" after the demo
    card.
  - Nobody has run the e2e specs, including how a real browser in the e2e stack gets a
    Turnstile token.
- **M7 (`wip(api)`). Fixed.** The commit is squashed. All 8 commits are conventional,
  with no AI mentions.
- **M1 (the hero loop has no pause). Not fixed. It doesn't block merging.**
  - It's a real WCAG 2.2.2 (Level A) failure against spec 14's bar, but it affects motion
    only.
  - Reduced motion already shows the end state, and it has no bearing on security or
    data.
  - Fix it before the UAT or submission: a pause button, or stop after two loops and
    pause on hover or focus.

## What the fixes broke

**N1 (Important). If Turnstile can't load or never yields a token, the demo is a dead end.**

`GuestOffer` won't start until `captcha.ready` (`demo-account.tsx:85-90`). The button is
disabled without it (`demo-account.tsx:144`). `useCaptcha` never becomes ready when the
script fails to load (`captcha.tsx:100-104`). Its `failed` flag isn't exposed, so the demo
can't react to it. What a person sees:

- With `?demo=1`, the landing page's main button: the "Opening the demo…" loader spins
  forever above the captcha's error.
- Without `?demo=1`: the button stays disabled, and the shared account's card and
  credentials never appear.

The shared account would still work: `/sign-in/email` isn't behind captcha. Spec 5.2
says "Demo sign-in fails: the normal form, with the credentials, no dead end".
Production has captcha on: `TURNSTILE_*` is in `production/secrets/api.sops.yaml`; I saw
only the key names, and the values are encrypted.

*Fix:*
- Expose `failed` from `useCaptcha`.
- In `GuestOffer`, treat a failed captcha like a failed guest sign-in: show the fallback
  alert and the shared account's card, and fill the form when `?demo=1` asked for it.
- Add a browser test that fails the Turnstile script request.

**N2 (Minor). Docs drift.** `docs/environment.md:168` still says Turnstile covers
"sign-up, emailed codes and password reset". The guest sign-in is missing from that list.

**N3 (Minor). Losing Valkey data resets the cap.** The live-guest count lives only in
Valkey (`demo:live-guests`), so a Valkey restart without persistence frees every place,
up to 50 more guests. That's acceptable given captcha and the per-address limit. Worth a
comment where the cap is defined.

The migration was edited in place. That's fine because it never reached master or
production. Anyone who applied the old version locally needs to reset their database.

## Result

**Needs fixes.** I1, I3, I4, M2 to M7 and spec 5.2's Google-first copy are done and look
correct. One fix is left: N1, the dead end when Turnstile is unavailable, which the
captcha change introduced on production's main demo path. It's a small change to
`useCaptcha` and `GuestOffer`, plus one browser test. M1 can follow as a separate change
and doesn't block merging.
