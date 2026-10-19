# Director v2, slice 7: fix round report

Branch `feat/mm/v2-demo-guests`, rebased onto `origin/master` (581ab3a) and force-pushed.
The `wip(api)` commit is squashed into the one that completed it, now
`1fefa0c feat(api): private demo guests, deleted after a day`. No PR opened.

## Commits

- 1fefa0c feat(api): private demo guests, deleted after a day (squashed: the wip commit + the worker commit)
- 4aac019 feat(web): one tap into the demo as a private guest
- edd0f60 feat(web): let the demo read the post Director wrote
- ebf0935 feat(web): a landing hero that's a conversation, and a quick start card
- 0cb4c3e docs(repo): document demo guests, and turn them on in production
- 2f62594 test(infra): check production gives the demo private guests
- 5e1dc1f fix(api): keep demo guests to their day, their cap and a guest's allowance (I1, I3, I4, M5)
- 05a578f feat(web): guard the demo with an invisible captcha, and an e2e of its path (I2 web, M2, M3, Google first, e2e)

## Fixes

**I1. Sessions end with the guest's day, on the server.**
- `apps/api/src/auth/auth-hooks.ts` adds a `session.update.before` hook that calls
  `clampToGuestDay` (`apps/api/src/auth/guest.ts`). It clamps any new expiry to the
  session user's `guestUntil`, so a refresh can't stretch the session. better-auth sets
  the Valkey TTL from `expiresAt`, so the cached copy expires with it.
- `auth.purge_expired_guests` now returns `(guest_id, session_tokens[])`. The worker
  deletes `auth:<token>` and `auth:active-sessions-<userId>` from Valkey for each guest
  (helper `authSessionKeys` and `AUTH_STORAGE_PREFIX` in `@repo/contracts/auth-settings`,
  now also used by auth.ts).
- Tests:
  - The API integration test drops the `dont_remember` cookie and sends only the session
    cookie: `expiresAt` stays at `guestUntil`, and the Valkey TTL is at most a day. I
    checked that this test fails without the hook (the expiry jumped to +7 days).
  - The worker integration test checks the expired guest's Valkey keys are gone after
    the purge, and the live guest's key stays.
  - Unit tests cover `clampToGuestDay`.

**I2. Captcha on the guest sign-in.**
- API: `captchaPlugins` adds `/sign-in/guest` to the Turnstile plugin's endpoints when
  guests are on. It's off where captcha is off, as elsewhere. The captcha integration
  suite now also checks that `/sign-in/guest` without a token gets 400.
- Web: `useCaptcha({ interactionOnly: true })` renders Turnstile with
  `appearance: "interaction-only"`, so it stays one tap. The demo button is disabled
  until a token exists, `?demo=1` waits for it, the token goes in `x-captcha-response`,
  and a failure resets it.
- Browser tests:
  - the guest call carries the token, and the widget is interaction-only;
  - `?demo=1` waits while Turnstile is held, then proceeds.
- To test this I added a `sentHeaders` command, and the fake Turnstile now records
  `data-appearance`.

**I3. Spend.**
- **Atomic cap:** live guests are a Valkey sorted set (`demo:live-guests`, scored by
  expiry). A single Lua script trims expired entries, counts, and adds. Tests:
  - 8 concurrent sign-ins with a cap of 4 give exactly 4 guests;
  - an expired score frees a place.
- **Limits:**
  - The `DEMO_GUEST_LIMIT` default is now 50, and production sets it explicitly to 50
    (stack.yaml, with a chart test).
  - The per-address limit (`DEMO_GUESTS_PER_ADDRESS`) defaults to 20.
- **Guest allowance:**
  - AI tokens: `AI_MONTHLY_TOKENS_PER_DEMO_GUEST` (default 300,000) in the AI service.
    `reserve` now takes an `Allowance(monthly, demo_guest)` and asks the new SECURITY
    DEFINER function `ai.demo_guest_workspace(org)` (granted to app_ai). A Python
    integration test shows a guest workspace capped at the guest allowance and a member
    workspace not.
  - Live calls: `DEMO_GUEST_LIVE_CALLS_PER_HOUR` (default 6) in the API. `OrgCaller` now
    has `guest`, and `spendCallLimit(caller)` picks the guest limiter. Unit tests cover
    both paths.
- **Cost record:** I chose a demo aggregate. Before deleting a guest's workspaces, the
  purge adds their `ai.usage` rows into a new `ai.demo_usage` table (month, feature,
  model, input and output tokens; not a tenant table). The worker test checks the sums.
  A narrow `owner_functions` policy lets the migrator read usage of expired guests only.
  An `USING (true)` policy broke the AI tests, which read as the migrator and rely on
  row-level security.

**I4.** The guest suite moved to Valkey database 30. docs/testing.md lists 29 for the
activity log and 30 for guests, and names 22, 23, 27 and 31 as free.

## Minor issues

- **M2:** My media holds back the publish trigger until `useSession` has resolved, so
  demo users never see "Publish" flash.
- **M3:** the hero's shot card now comes after the `<ol>` in the DOM (its position on
  screen is unchanged). A server-render test asserts the order.
- **M4:** the per-IP limit is 20 an hour.
- **M5:** the shared fallback account's takes and videos older than a day are now
  deleted.
  - A new SECURITY DEFINER function, `files.purge_demo_footage`, runs from the same
    worker task, renamed `demo-retention`. Its owner policy on files.file covers the
    shared demo account's files only.
  - The worker test checks that the old file and its storage object are deleted, and
    that a recent file and another user's file are kept.
- **M6, e2e:** new `apps/web/e2e/demo-guests.spec.ts`:
  - "Try it now" on two devices gives separate guests and workspaces, and the first
    guest's own Short isn't in the second's library;
  - the guest card signs in.

  Biome forbids `test.skip`, so the guest spec runs unconditionally. `DEMO_GUESTS=on` is
  now in .env.example, as in production, and `scripts/e2e.ts` defaults it on (tested in
  scripts/e2e.test.ts). `demo.spec.ts` now covers the shared account as the fallback (it
  routes the guest call to `DEMO_GUESTS_FULL`). I didn't run e2e locally.
- **Spec 5.2 "Google first":** the sign-in page shows "Continue with Google, to post to
  your channel" right after the demo card, outline style so there's one primary button.
- **M7:** the wip commit is squashed.
- **Not done:** M1 (a pause for the hero loop, WCAG 2.2.2) wasn't in this round's list.
  Reduced motion already shows the end state.

## Migration

`20261018200000_demo_guests` is still expand-only on existing tables: a nullable column,
a new `ai.demo_usage` table, three SECURITY DEFINER functions with REVOKE and GRANT, and
two narrow owner policies. I edited it in place, since it isn't on master, and re-applied
it on my stack. Results: `db:lint` 0 issues, `drift` clean, and `@repo/db` integration
(security tests) 30 passed.

## Checks (stack 2)

- `bun run lint` passes: biome, boundaries, knip, patterns, suppressions and the rest.
- `bun run check-types` passes (24 tasks). `bun run test` passes (all unit). `bun run gen`
  leaves the tree clean.
- Integration tests:
  - API: demo-guests (17), captcha, features-off and publish suites;
  - the full API integration suite (170 passed), worker integration (23 passed, plus 19
    tagged files, with RustFS), and `charts:check`;
  - AI: test_budgets, test_models_match_db, test_director and test_speech (90 passed).
- Browser tests, single files only:
  - `sign-in.test.tsx` (17);
  - `sign-in.features-off`, the `test/components` captcha tests and `sign-up.test.tsx`;
  - `publish-sheet.test.tsx` (16).
- Script tests: 2 failures in `scripts/pre-push.test.ts` come from this checkout's stack
  ports (55632, where the test expects 55432). They aren't related to this change.

## Local notes

This worktree's `.env` and `.env.stack` put stack 2's Valkey on 46579, because 56579 is
in macOS's ephemeral range and wouldn't bind. The change is local and untracked.
