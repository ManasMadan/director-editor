# Tasks 2.3.4 + 2.3.5 + 2.3.1b report: library, template page, Gemini loader, brand shell

(Written inside the worktree: the isolation guard refused the shared-checkout path.)

Worktree `.claude/worktrees/agent-a9133bf95c8692663`, branch
`worktree-agent-a9133bf95c8692663`, based on `6cb1ddc` (origin/feat/mm/director-hackathon
at dispatch). Stack 8 (`bun run setup --stack 8`: web 3800, api 3801, ai 8800, Postgres
56232); stopped with `bun run db:down` at the end.

## Commits (`6cb1ddc..764b37b`)

- `5663f00` feat(web): a library of templates and a template page you can shoot from
- `8907ef3` feat(api)!: remove the Shorts feed, keeping only the YouTube check before indexing
- `04cfb5c` test(web): name the YouTube key the credit e2e spec is skipped without
- `764b37b` refactor(web): name the indexing step instead of counting it, and cover a failure with no reason

About 120 files, +2.4k / -10.6k (most of the minus is the removed feed).

## What changed and why

### 2.3.4 Library (`/library`)
- `apps/web/src/modules/director/pages/library.tsx`: heading ("Pick a Short. Shoot your
  own."), a one-line intro for first-timers, the "Bring your own Short" card and the
  templates grid (2 columns on a phone, 3/4 wider; on desktop the heading and card sit
  in a sticky left column).
- `components/template-card.tsx`: portrait card with YouTube's own thumbnail
  (`i.ytimg.com/vi/<id>/hqdefault.jpg` cropped to 9:16), Starter / Indexed badge
  (`source`), title, shot count and length, and the plan's shot rhythm along the foot
  (one bar per shot, as wide as its share; photos dimmer). That strip is the one
  distinctive visual: it's the short's real structure. A pending or analyzing plan
  shimmers (GeminiShimmer) with its stage; a failed one says "Couldn't index".
- `components/index-card.tsx`: aurora-edged card (the only place Gemini's colours sit on
  the page). Paste a link and it calls `director.index`. While indexing it follows the
  plan through the library query (`director.changed` realtime plus a 3 s poll) and shows
  `IndexProgress` (GeminiLoader and a 4-step track: Queued, Watching, Writing shots,
  Ready). Ready shows "See the shots". Failed shows the reason and "Try another link". A
  link to a short already in the library opens it. `indexUsed` shows a hint.
- `components/credit-dialog.tsx`: on `DIRECTOR_INDEX_LIMIT`, a dialog "You've used your
  AI credit" with the workspace's ready seed templates as thumbnails linking to each,
  and "Got it". **[RF 1]**
- Stages: `lib/library.ts` `indexStep(status, stage)` maps the contract's stages to a
  step, and falls back on `status` for a stage it doesn't know (2.1.3 may add finer
  ones), so the page never breaks on a new stage.
- Removed the YouTube feed completely, per the controller's ruling:
  - Web: the `modules/shorts` pages and components, `/saved`, `/shorts` and their tests.
  - `packages/client/src/api/shorts/*`.
  - `packages/contracts/src/api/shorts.ts`.
  - The api `shorts.router` and `shorts.repository`, and the search and comments reads
    in `youtube.ts`.
  - `SHORT_NOT_FOUND`, the `shorts` i18n namespace, and fake-google's search, comments
    and topics.
- What I kept:
  - The YouTube `videos` read, now `YouTube.video(id)`, which returns the id and
    duration and is cached for an hour. `ShortsService.filmable` uses it before
    indexing.
  - In web `modules/shorts`: only `YouTubeEmbed`, `sendCommand`, `thumbnailUrl` and
    `DirectorGate`. shoot.tsx, which I couldn't edit, imports the gate and the embed
    from that barrel.
- `/shorts/[id]` now redirects permanently (308) to `/director/[id]`. `/home` was never a
  route on this branch.
- `SHORT_MAX_SECONDS` and `SHORT_URL_MAX_LENGTH` moved into
  `contracts/src/api/director.ts`.

### 2.3.5 Template page (`/director/[videoId]`)
- Original player hero kept (YouTube embed, mute toggle, tap a storyboard segment to
  play that shot's part). The back link goes to `/library`.
- `components/shot-list.tsx` shot cards show:
  - purpose and scene;
  - a framing box: a 9:16 mini frame with the subject box drawn dashed, with an
    accessible name;
  - shot size and framing note;
  - phone angle: height, "Tilted up 15°" or "Held level" from pitch against tolerance,
    and which camera;
  - the script lines;
  - the member's take state from `director.shots`: scored, needs a retake, being
    reviewed, or filmed.
- Audio note: with `audio.status === "failed"` the page says "The original audio
  couldn't be fetched, so your mic will be used." and starts the shoot with
  `audio=voice` (no choice offered).
- The button reads "Start shooting". Once some shots are filmed it reads "Continue
  shooting" and opens the first shot without a take.
- No "Try again" spends the index any more (review note):
  - Pending or analyzing: `IndexProgress`.
  - Failed: the reason, a note that a failed short doesn't use up your own, and a link
    to the library.
  - Not in the library (`DIRECTOR_PLAN_NOT_FOUND`): a link to the library.
  - Only a plan that can't be read offers "Try again", and that refetches the plan.
  - Tests check that this page never calls `/rpc/director/index`.
- Storyboard images and Veo previews aren't rendered: the contract doesn't carry them
  yet (2.6.3), and there are no placeholders.

### 2.3.1b Gemini loader everywhere, brand shell
- `rg "Spinner|animate-spin|Skeleton" apps/web/src` now only hits `pages/shoot.tsx` and
  `components/directors-cut.tsx`. Both belong to the agent fixing the shoot page, so I
  left them.
- Replaced with GeminiLoader and a translated label: review.tsx, clip-panel,
  edit-timeline, edit-player, avatar-card.
- Replaced with GeminiShimmer: the passkeys, profile and sessions cards, the site
  header, and the DirectorGate loading state.
- `SiteHeader` is Director's dark bar in both themes: the wordmark with a record dot,
  `Library` in the nav (with aria-current), the theme toggle, and the user menu
  (Settings, Sign out). There's no workspace UI. I removed the user menu's duplicate
  "Library" item.
- My media isn't linked: /media belongs to 2.3.7 and I didn't add a stub route. Adding
  it later is one entry in `NAV` in `site-header.tsx` plus its i18n label.
- `SiteChrome`: a new `STUDIO_PATHS` (`/library`) puts the header and page on the dark
  stage. `IMMERSIVE_PATHS` is now just `/director`.

### Coordinator's item: the session check on /library (the 5 CI e2e specs)
- `DirectorGate` now also runs `useMeQuery()`, with a comment saying why. Every Director
  page now checks the session whatever the feature flag says, so an ended session gets
  the 401 that sends it to sign-in. The "off" state still renders for a signed-in
  member.
- Pinned by `apps/web/test/director/library.features-off.test.tsx` (the API with
  features off).
- TDD evidence: with the `useMeQuery()` line commented out, that file fails with
  `× sends a member whose session ended to sign in, though Director is off` and
  `AssertionError: expected '/library' to be '/sign-in?next=%2Flibrary'` (1 failed,
  1 passed). With the line in place, both pass.
- The five specs pass on my stack: auth.spec.ts:92 and :156, password-reset.spec.ts:3,
  and settings.spec.ts:34 and :56 (e2e results below).

### Client hooks
- In `packages/client/src/api/director/`:
  - `library.ts`: `useDirectorLibraryQuery`, which polls every 3 s while any plan is in
    progress.
  - `shots.ts`: `useDirectorShotsQuery`, which polls while a take is being reviewed.
  - `progress.ts`: `planInProgress`, shared with `plan.ts`.
- TDD: the new tests in `director.test.tsx` failed first because the modules didn't
  exist ("1 failed | 14 passed" test files), then passed: 88 tests.

### Tests and fixtures
- `apps/web/test/fake-ai.ts`: the AI stand-in now keeps a library per workspace
  (`PUT /__fake/library/<orgId>`, `GET /v1/director/library`) and indexes like the real
  service:
  - a short already there is answered with its plan;
  - with `indexUsed`, it refuses with `DIRECTOR_INDEX_LIMIT`;
  - otherwise it adds a pending plan and marks the index used.
- `commands.fakeLibrary(orgId, state)` sets a workspace's library from a test.
- `test/director/library.test.tsx`, 10 browser tests: the grid; empty and error states;
  live stage progress through realtime; the credit dialog offering only seeds; opening
  an existing short; link errors; and failures with and without a reason.
- `test/director/director.test.tsx`: rewritten for the new template page (13 tests).
- e2e `apps/web/e2e/library.spec.ts` **[RF 1]**:
  - Signs up, then writes one user plan and one seed straight into `ai.director_plan`
    as `app_ai`, with `app.org_id` set so row-level security applies.
  - Pastes a real public video. Expects the credit dialog offering the seed, an
    axe-clean page, nothing added, and the offered seed opening.
  - It needs Director on (a real YouTube key and the AI service), so it skips otherwise:
    CI's e2e job has no YouTube key.
  - The skip is listed under "Skipped tests" in docs/testing.md and added to biome's
    `noSkippedTests` override beside the captcha and Google specs.
  - The same refusal is covered on every run by the browser test above.
- `lib/library.test.ts`: unit tests for `indexStep`, `shotRhythm`, `angleOf` and
  `nextShot`.
- I updated the api, db, contracts, nest-common and client tests that used shorts
  procedures or `SHORT_NOT_FOUND`:
  - Membership checks now use `director.library`, which answers FEATURE_DISABLED once a
    member is let through in that harness.
  - The account-deletion tests count `ai.director_plan` rows instead of reactions.

## Commands and results

- `bun run lint`: exit 0. Biome, boundaries, unused (knip), markers, patterns,
  suppressions, prisma, actionlint, zizmor, shellcheck, hadolint, tflint, renovate and
  turbo lint all pass.
- `bun run check-types`: 24 successful, 24 total.
- `bun run type-coverage`: every workspace passes.
- `bun run gen`: no drift. openapi.json, the AI contracts and the i18n `.d.json.ts` were
  regenerated and committed.
- `bun run test --continue`: 21 of 22 tasks pass. The one failure is
  `@repo/testing` `src/stack.test.ts` ("moves the apps' own ports ...", expected
  `GOOGLE_BASE_URL`). That's pre-existing: I didn't touch `packages/testing` or
  `.env.example`. An earlier run also timed out three `env.test.ts` files in
  notifications, webhooks and worker under load; they passed on rerun.
- `bun test ./scripts/ ./.claude/hooks/`: 970 pass, 3 fail.
  - I fixed my one failure, in `testing-docs.test.ts`: the skip message now names
    `YOUTUBE_API_KEY`.
  - The other two are in `pre-push.test.ts` ("the database steps"). They expect port
    55432 and get 56232, which is my stack-8 port: an environment artefact, not a code
    problem.
- `bun run test:integration --filter=@repo/api --filter=@repo/web --filter=@repo/db`:
  - db: 28 passed;
  - api: 98 passed, 13 skipped;
  - web: 296 passed, 16 skipped (49 files passed, 1 skipped);
  - 9 of 9 tasks succeeded.
- e2e against my `bun dev:full` on stack 8 (real Google services), running
  `bun run --cwd apps/web test:e2e e2e/auth.spec.ts e2e/password-reset.spec.ts
  e2e/settings.spec.ts e2e/library.spec.ts e2e/platform.spec.ts`: **44 passed (1.1m)**.
  That includes the five sign-out specs and the RF1 library spec with the real YouTube
  check.
  - An earlier run of the same command had 11 failures. That was because I was editing
    apps/api while it ran, so the dev API kept restarting ("Internal Server Error",
    captcha never loading). The clean rerun is the result that counts.
- Coverage (`bun run --filter @repo/web coverage`, then api/client/contracts/fake-google,
  then `bun scripts/coverage.ts`): every file I touched is at 100%. That covers the web
  director components, pages and lib, the shell, the gate and routes; the client
  director hooks; the api shorts module; contracts; and fake-google.
  - The web coverage run had 2 timing failures: shoot.test "takes the last shot's
    photo" (the shoot page belongs to another agent) and avatar "storage refuses the
    upload". Both passed in the plain integration run.
  - The avatar failure leaves avatar-card's line-96 branch uncovered in that merged
    report. That line is unrelated to my change; mine was the loader at line ~160.
  - Running web and api coverage at the same time exhausted database connections, so I
    ran them one after the other.

## Screenshots (playwright-cli, session `library`, stack 8, demo user, seeds inserted directly)
- `.claude/worktrees/agent-a9133bf95c8692663/.playwright-cli/library-mobile-full.png`:
  the library at iPhone 15 width (badges, shot rhythm, an indexing card, the aurora
  card).
- `.claude/worktrees/agent-a9133bf95c8692663/.playwright-cli/library-credit-modal.png`:
  the "You've used your AI credit" dialog from a real API refusal.
- `.claude/worktrees/agent-a9133bf95c8692663/.playwright-cli/template-mobile-full.png`
  (and `template-mobile-shots.png` close up): the template page with storyboard,
  framing boxes, phone angle and lines.
- `.claude/worktrees/agent-a9133bf95c8692663/.playwright-cli/library-desktop.png`: the
  desktop two-column layout.

## Decisions the brief didn't make
- I kept `apps/api/src/modules/shorts`, now only the YouTube link check, and the web
  `modules/shorts` barrel (embed and gate) rather than renaming them, because
  shoot.tsx imports from it. Worth renaming once that work merges.
- I didn't drop `app.short_reaction`: expand/contract means that's a later release's
  migration. `packages/db/test/enums.test.ts` now pins its CHECK to `["like","save"]`.
- Removing the procedures is a breaking `/api/v1` change that oasdiff will flag. The
  commit carries `!`, and PR #8's title already does.
- I extended the `noSkippedTests` override in `biome.jsonc` for the RF1 skip and added
  its docs/testing.md rows. That's a lint-config change. No hook refused it, but I'm
  flagging it.
- Thumbnails use `hqdefault.jpg`, which every video has (`oardefault` often 404s).
- The RF1 e2e pastes "Me at the zoo" (`jNQXAC9IVRw`, 19 s), so YouTube's length check
  passes. The fake catalog's `HasaZYkwYds` is really longer than 180 s and gets
  DIRECTOR_TOO_LONG.

## Concerns
- Docs and rules still name the removed Shorts feature as the reference example:
  `.claude/rules/api.md`, `client.md` and `contracts.md`; the add-feature,
  add-web-page and db-change skills; `apps/api/CLAUDE.md`; and `docs/director.md`
  (whose route table lists `/shorts/[videoId]`) and `docs/web-and-mobile.md`. They need
  a docs-sync pass; I didn't rewrite the template's conventions here.
- origin/feat/mm/director-hackathon moved on during this task (2.2.2 seeds:
  `d44df31..1d603ad`). My branch is on `6cb1ddc`, so it needs a merge or rebase.
  Conflicts are likely in `fake-ai.ts`, en.json and the api director tests.
- Two browser tests outside my area are timing-sensitive under coverage
  instrumentation: shoot.test ("takes the last shot's photo") and the avatar
  "storage refuses" test.

## Fix round 1 (review 1)

**Rebase.** I rebased onto `origin/feat/mm/director-hackathon` at `ac49484` (seed copying
2.2.2, the staged Cloud Run indexer 2.1.3+2.1.5, the live call 2.5.2).
- Conflicts were only in `packages/i18n/messages/en.json` and `en.d.json.ts`, and the
  generated `ai-client/types.gen.ts`. I resolved en.json by taking origin's file and
  reapplying my key changes (the diff came out identical, 142 lines), then regenerated.
- `fake-ai.ts` and the api director tests merged without conflicts.
- After the rebase, `bun run gen` leaves no drift and `check-types` passes 24/24.
- New range: `899301d..6e50ffb`. The original four commits, rebased, are 899301d,
  2b44472, ca2e8b8 and 1167427.

New commits:
- `0738613` fix(web): give the template its own bar above the player, and tidy its accessibility
- `4a5d319` docs: point the rules, skills and docs at Director's library now that the Shorts feed is gone
- `6e50ffb` test(web): check the credit dialog against the copied seed templates, and where focus lands

| Item | Change | Test |
|---|---|---|
| 1 Header over YouTube's title (Important) | `apps/web/src/modules/director/pages/director.tsx:156-191` `TemplateBar`, a solid sticky row above the player (back link, title, mute) with `pt-[max(0.5rem,env(safe-area-inset-top))]`, used at `:208`. The floating overlay and the "Director" pill are gone. | `test/director/director.test.tsx`: the banner doesn't contain the iframe, and there's no "Director" text on the ready page. Screenshot `fix1-template-mobile.png` shows YouTube's own title in full. |
| 2 Stale docs and rules (Important) | Updated `.claude/rules/client.md`, `contracts.md` and `api.md`; skills `add-feature` and `add-web-page`; `apps/api/CLAUDE.md`; `docs/director.md` (intro, diagram, route table, "Where things are", limits); `docs/web-and-mobile.md`, `README.md`, `auth.md` (rate limits), `environment.md`, `new-project.md` and `testing.md`; `.env.example` and the `YOUTUBE_API_KEY` comment in `apps/api/src/env.ts`; the `apps/web/test/global-setup.ts` header. They now point at code that exists: the director library and hooks, `modules/files` and `contracts/api/director.ts`. | `git grep` finds no path to a removed file (`api/shorts`, `shorts.feed`, `reacted`, `/saved`, `useSavedShorts`). `bun test scripts/claude-setup.test.ts scripts/testing-docs.test.ts`: 0 fail. |
| 3 Plan title as the page's h1 | `director.tsx:169`. "Film them in this order" is now an h2. | `director.test.tsx`: `heading level 1 "Morning routine"` |
| 4 Watch buttons named, shot titles as headings | `components/shot-list.tsx:204` (`template.watchShot` aria-label) and `:184` (`<h3>`) | `director.test.tsx`: clicks "Watch shot 1: Walk in" on the card, and finds `heading level 3 "The look"` |
| 5 Focus after "Got it" | `credit-dialog.tsx:28-41` takes `finalFocus`. `pages/library.tsx` makes a `linkField` ref and threads it through `IndexCard` and `LinkForm` to the `Input`. | `test/director/library.test.tsx`: the link field has focus after "Got it". The e2e spec checks the same with `toBeFocused`. |
| 6 "Start shooting" is a link | `director.tsx:293` `<Link href=/director/<id>/shoot?shot=..&audio=..>`; `useRouter` removed | `director.test.tsx`: `link "Start shooting"` with its href, and the clicks |
| 7 "Yours" badge | `library.card.user` is now "Yours" in `packages/i18n/messages/en.json` | `library.test.tsx` matches /Yours/ |
| 8 Reduced motion | `director.tsx:251` `scrollToPlayer()` uses `behavior: "auto"` under `prefers-reduced-motion: reduce`, otherwise "smooth" | `director.test.tsx` "scrolls back to the player (reduced motion: true/false)": matchMedia stubbed, scrollTo spied |
| Controller: /media nav | /media doesn't exist after the rebase, so the nav still has only Library | n/a |
| Also | The last spinner, `components/directors-cut.tsx:190` (the shoot-page work has merged, so the file is free now), is a GeminiLoader labelled "Sending your take to Director…". `rg "Spinner\|animate-spin\|Skeleton" apps/web/src` is now empty. | `test/director/canvas-layers.test.tsx`: `status "Sending your take to Director…"` |

The library e2e spec now reads the template count before indexing and compares it after,
since every workspace starts with the 6 copied seeds. The starter's title is an h1.

**TDD.** I ran the new and updated tests against the pre-fix sources: 10 failed, 22
passed in director, library and canvas-layers. That covers the bar and h1, watch-button
names, the Start shooting link, reduced motion, "Yours", the focus check and the loader
label. Against the fixed sources: 32 of 32 pass after one locator fix (the storyboard and
the card now share a button name, so the storyboard click is scoped to its list).

**Checks (stack 8):**
- `bun run lint`: every check passes.
- `bun run check-types`: 24/24.
- `bun run --filter @repo/web test`: 186 passed. `@repo/client`: 77 passed.
- `bun run --filter @repo/web test:integration`: 316 passed, 17 skipped (50 files passed,
  1 skipped).
- e2e against `bun dev:full` on stack 8:
  `bun run --cwd apps/web test:e2e e2e/auth.spec.ts e2e/password-reset.spec.ts
  e2e/settings.spec.ts e2e/library.spec.ts`: **24 passed**. That includes the five
  sign-out specs and `library.spec.ts:84` [RF 1], which ran rather than skipped.
- Web coverage: every file I changed is at 100%. The only miss in apps/web/src is
  `avatar-card.tsx` branch 96, from the avatar "storage refuses the upload" test, which
  is timing-flaky under coverage and outside this change.
- Stack stopped (`bun run db:down`).

**New screenshots** (real seed templates, copied at sign-up, for a fresh user):
- `.claude/worktrees/agent-a9133bf95c8692663/.playwright-cli/fix1-library-mobile-full.png`:
  the library with the 6 real seeds.
- `.claude/worktrees/agent-a9133bf95c8692663/.playwright-cli/fix1-template-mobile.png`:
  the template bar above the player, with YouTube's own title uncovered.
- `.claude/worktrees/agent-a9133bf95c8692663/.playwright-cli/fix1-template-mobile-full.png`:
  the whole template page.
- `.claude/worktrees/agent-a9133bf95c8692663/.playwright-cli/fix1-library-credit-modal.png`:
  the credit dialog offering the 6 real seeds, from a real API refusal.
