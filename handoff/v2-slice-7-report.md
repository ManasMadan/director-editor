# Director v2, slice 7 (the parts that don't need the new shoot screen): report

Branch `feat/mm/v2-demo-guests` (from `origin/master` ae43b93), pushed. No PR opened.

## What I built

### 1. One-tap demo with private guest workspaces

- **Guest sign-in** (`apps/api/src/auth/guest.ts`): a small better-auth plugin with one
  endpoint, `POST /api/auth/sign-in/guest`, on only with `DEMO_GUESTS=on`
  (`features.demoGuests` in `system.info`). Each call makes a new user through
  better-auth's adapter, so the existing sign-up hooks give it a personal workspace with
  the 6 seeded templates (the usual tenancy: one member per workspace, RLS by org). The
  guest:
  - gets `demo = true`, so every existing demo restriction applies (no publishing;
    `DEMO_LOCKED_PATHS`: no password, passkey, Google link, 2FA, session revoking or
    workspace changes; no rename or avatar; its device list shows only its own session);
  - gets `guest_until = now + 24 h` (a new nullable column `auth.user.guest_until`,
    registered as the better-auth additional field `guestUntil`, never client input);
  - has an address on the reserved `guest.invalid` domain, so nothing is ever mailed, and
    the name "Guest" in its own language (through `@repo/i18n`);
  - has a session that ends exactly at `guest_until` and is never extended. It's
    better-auth's "don't remember me" session, and both cookies (the session cookie and
    better-auth's "don't remember me" cookie) have Max-Age 86400, so closing the browser
    can't drop the mark and let better-auth extend the session past the day.
  - A browser that's already signed in (a guest within its day, or a member) gets no new
    guest (`{ created: false }`).
- **Abuse limits**: `DEMO_GUESTS_PER_ADDRESS` (default 5) guests per client IP per hour,
  through the plugin's better-auth rate-limit rule (429), and `DEMO_GUEST_LIMIT`
  (default 300) live guests in all (`DEMO_GUESTS_FULL`, 503).
- **24-hour cleanup**: migration `20261018200000_demo_guests` adds the column and
  `auth.purge_expired_guests(max_guests)`, a SECURITY DEFINER function that only
  `app_worker` can run. It deletes each expired guest's sole workspaces (plans, takes and
  cuts cascade), then the user (sessions, accounts and files cascade; the files trigger
  queues their storage objects). The worker's new `demo-guests` maintenance task (hourly
  at :20) calls it in batches of 100 until a batch comes up short, then runs the files
  cleanup, so the footage leaves storage in the same run.
- **The switch and the fallback**: the shared demo account keeps working unchanged. With
  guests on it becomes the fallback; with guests off the demo works exactly as before.
  Production gets `DEMO_GUESTS: "on"` in `deploy/environments/production/stack.yaml`, and
  its `DEMO_PASSWORD` stays.
- **Web** (`apps/web/src/modules/auth/components/demo-account.tsx`): with guests on, the
  sign-in card reads "Just looking? Use the demo. Your footage is deleted after a day, and
  posting to YouTube is off.", and its button signs in as a guest. `?demo=1` starts it at
  once and goes on to `next` (the library by default). If no guest can be made, the
  shared account's card appears with its email and password filled into the form, and a
  line saying others see what's filmed in it. With no shared account it says why (full,
  or too many tries) and the button retries. The client side is a tiny better-auth client
  plugin in `packages/client/src/auth/client.ts`, so the session refreshes everywhere
  after the guest sign-in.

### 2. Landing page hero and copy, and the Quick start card

- **Hero** (`apps/web/src/modules/marketing/components/hero-chat.tsx`, CSS in
  `landing.css`): a 10-second CSS-only loop over a drawn selfie frame. Director asks for
  the market, you say "I'm fine inside", Director says "Inside it is!", and the shot card
  changes from "Where: the market" to "Where: by your window ✓", with a REC indicator.
  It's real text in reading order for screen readers, rests on the end state with reduced
  motion, and needs no JavaScript and nothing to download.
- Copy per 5.1: "Watch any Short. Shoot your own." / "A friend on your phone helps you film
  it, shot by shot." / "Try it now, no sign-up" (signs straight into the demo). Each
  template on the landing page opens itself after the demo sign-in (`next=`). Steps: "Pick
  a Short", "Shoot it with Director", "Post it to YouTube Shorts", with no "live call"
  wording. The x-ray moved to its own section ("How Director reads a Short"). Built on
  Google Cloud adds Compute Engine, and BigQuery's line drops "live call".
- **Quick start card** (spec 5.3, library): the head-nod starter (`22k0fZarxh8`) shows as
  "★ Quick start … Just you, talking to the camera. Works indoors." above the templates
  once it's ready in the library.

### 3. Read-only post for the demo

- In My media, a demo session (a guest or the shared account) sees "See the post Director
  wrote" instead of Publish. The sheet ("The post Director wrote", "Posting is off for the
  demo. Sign in with Google to post your own.") shows Gemini's title, description,
  hashtags and credits as text, with nothing to send. `publish.copy` already allowed the
  demo; I added a test proving it. `PUBLISH_DEMO_DISABLED`'s message is now the spec's
  sentence.

## Decisions made where the spec was silent (owner away)

1. **A user per guest, not a workspace under the demo account.** Workspaces here have
   exactly one member (`WORKSPACE_MEMBER_LIMIT = 1`), and the shared account's sessions
   can't tell browsers apart. A separate user per browser fits better-auth and the tenancy
   as they are, and deleting the user deletes everything it made.
2. **A small custom better-auth plugin, not the stock anonymous plugin.** The anonymous
   plugin's sessions last 7 days and slide, while a guest's must end at 24 h with its data.
   It also adds a `/delete-anonymous-user` endpoint that would skip deleting the workspace,
   and an after-hook on every sign-in. The custom endpoint is about 60 lines on
   better-auth's own adapter, cookies and rate limiter.
3. **The shared account stays as the fallback** (spec 5.2: "Demo sign-in fails: the normal
   form, with the credentials, no dead end"). Its password stays hidden while guests are
   given out and shows only when no guest can be made.
4. **The demo restrictions apply to guests too**, through the `demo` flag. Spec 8.8's "5
   images per demo guest" belongs to the asset picker slice and isn't built here.
5. **Limits**: 5 guests per IP per hour and 300 live at once, both settable by env.
6. **No audit events for purged guests.** Only the audit log consumes `org.deleted.v1`,
   and the workspace's log goes with it. The worker logs the counts.
7. **The landing's step 1 says "Pick a Short", not "Pick or describe a Short"**, because
   creating a template from a description is slice 15 and isn't built yet. The copy needs
   updating when it ships. The hero's "Inside it is" exchange follows the spec as the v2
   behavior.
8. **The Quick start card shows for everyone**, not only the demo, since it helps any
   newcomer. The time question and the sample session from slice 7 are out of my scope
   (they need the shoot screen).
9. **No partial index on `guest_until`.** An index on an existing table has to be
   `CONCURRENTLY` in its own migration, and `auth.user` is small, so the count and the
   purge are cheap without one. Add it if the table grows.

## Risks worth knowing

- **AI spend**: each guest has its own workspace AI allowance and one indexed Short, where
  the shared account had one between everyone. `DEMO_GUEST_LIMIT` bounds the total; lower
  it if spend matters.
- **Guest sign-in has no captcha** (it's one tap), so a bot could fill the 300 cap until
  guests expire. The demo then falls back to the shared account rather than failing. The
  per-IP limit depends on the gateway setting `X-Forwarded-For`, like every other auth
  rate limit.
- The first commit's message starts with `wip(api)`, because I was asked to pause
  mid-change. The later commits complete it.

## Tests and checks (all run on stack 2)

- New API integration suite `apps/api/test/demo-guests.integration.test.ts`, 15 tests:
  - sign-in, the workspace and its seeds;
  - the cookies' Max-Age, and the session never being extended;
  - a guest coming back, and members left untouched;
  - two guests isolated from each other;
  - the locked paths, and publishing refused;
  - the new fields can't be claimed through sign-up or profile edits;
  - the per-address 429, the total cap, and room freeing up as days end.
- Features-off covers the switch being off (404). The publish suite shows the demo still
  drafts the post.
- Worker integration:
  - purging 101 expired guests (more than a batch) with their workspace, plan, file row
    and storage object;
  - live guests and members are kept;
  - app_api can't run the function, and app_worker can't delete users;
  - the schedule is registered.
- Browser tests, single files only:
  - `sign-in.test.tsx`: the guest card, `?demo=1` with `next`, the fallback to the shared
    account, the error with no shared account, guests off, and system.info down;
  - `sign-in.features-off.test.tsx`;
  - `publish-sheet.test.tsx`: two read-only post tests;
  - `library.test.tsx`: the Quick start shown or not.
- Unit: the client plugin, `quickStartOf`, and the landing's server-render tests.
- Passing:
  - `bun run lint` (biome, boundaries, knip, patterns and the rest) and `bun run check-types`;
  - type coverage for api, web, client and worker;
  - `bun run test` (all unit) and the whole api integration suite (161 passed);
  - `@repo/db` integration (security tests), `db:lint` and `drift`;
  - `charts:check`, plus a production chart test for the switch;
  - the env-docs, redis-databases and testing-docs script tests;
  - `bun run gen` with no drift.
- Not run: the e2e suites and broad browser suites (machine constraint). I updated
  `e2e/platform.spec.ts` for the new button name. `e2e/demo.spec.ts` is unchanged because
  e2e stacks run with guests off.

## Commits

- a0b5faf wip(api): private demo guests, deleted after a day
- 1e9b5c6 feat(worker): delete demo guests when their day is over
- 95dad88 feat(web): one tap into the demo as a private guest
- 9f68b0f feat(web): let the demo read the post Director wrote
- e208db7 feat(web): a landing hero that's a conversation, and a quick start card
- 7919a82 docs(repo): document demo guests, and turn them on in production
- 1e683f8 test(infra): check production gives the demo private guests

## Local notes

Docker couldn't bind stack 2's Valkey port (56579, which is in macOS's ephemeral range),
so this worktree's `.env` and `.env.stack` use 46579 for Valkey. That change is local and
untracked. The stack is stopped with `bun run db:down`.
