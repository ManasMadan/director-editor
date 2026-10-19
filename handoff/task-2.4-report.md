# Task 2.4 report: Google sign-in's test and publishing to YouTube Shorts

Status: DONE_WITH_CONCERNS (see "Concerns")

(Written in the worktree: the isolation guard refused the shared-checkout path.)

Branch `worktree-agent-a8de707cda903e3e5`, rebased on `origin/feat/mm/director-hackathon`
at `14ace46` (demo account and My media both merged). Stack 7 (`bun run setup --stack 7`,
files profile up for the `files`-tagged suites).

## Commits (oldest first, `origin/feat/mm/director-hackathon..HEAD`)

- `a496de6` feat(db): let the API record how a cut's publishing went
- `57aebee` feat(ai): let Gemini write a cut's YouTube post
- `f76d4e4` feat(api): publish a cut to YouTube Shorts with the member's Google account
- `c58951f` feat(client): add hooks for a cut's YouTube post and publishing it
- `53c7647` feat(web): a publish sheet for a cut, with Director's post and YouTube's real privacy
- `35d469a` refactor(contracts): keep the publish contract's internal limits unexported
- `aa778c8` fix(contracts): count a description's UTF-8 bytes without TextEncoder
- `de55500` fix(fake-google): read an upload's bytes as a buffer, typed
- `cda7769` test(api): publishing with uploads off says so, rather than failing
- `81427a3` feat(web): publish a video from its card in My media

The demo-flag stand-in I first added (the same migration `20261018183000_demo_user`,
`auth.prisma` field and `userAdditionalFields.demo`, copied byte for byte from the demo
branch) dropped out on rebase as already upstream. Nothing of it is left on the branch.
Publishing reads the real flag: `result.user.demo` in `orgCallerFor`, exposed as
`context.demo` on `OrgCaller` (that one field is my addition to `procedures.ts`).

## What changed, and why

### Database (`20261018190000_director_cut_publish`)
This follows the controller ruling: a column-level grant,
`GRANT UPDATE (publish_status, youtube_video_id, visibility, updated_at) ON ai.director_cut TO app_api`.
It only adds a privilege, so it's expand-only. I added `updated_at` to the three named
columns for two reasons: Prisma's `@updatedAt` writes it on every update, and it's how
the API tells a publish that was cut off mid-upload from one still running. In
`packages/db/test/security.test.ts`, app_api can update those columns on a cut in its own
workspace and gets 0 rows on another workspace's. It's refused on title, picks, file_id,
user_id, duration_ms, DELETE and INSERT. This replaces the old "can read but not change"
case.

### Contracts
- `packages/contracts/src/api/publish.ts`:
  - `publish.copy`: POST `/media/{cutId}/publish-copy` returns
    `{title, description, hashtags, credits}`. Limit: 20 per hour per user.
  - `publish.upload`: POST `/media/{cutId}/publish` takes
    `{title, description, hashtags, credits, visibility = "unlisted"}` and returns the
    `DirectorCut`. Limit: 5 per hour per user, because each upload uses a large share of
    YouTube's daily quota.
  - Shared helpers: `youtubeTitle` (adds ` #Shorts` unless the title already has it),
    `youtubeDescription` (the description, then the hashtags, then the credits and
    `https://youtube.com/shorts/<original>`), `descriptionBytes` and
    `YOUTUBE_UPLOAD_SCOPE`.
  - The input refuses `<` and `>` (YouTube does too), takes hashtags as single words
    without `#`, and refuses a composed description over YouTube's 5,000 bytes.
- Error codes, all translated:
  - `DIRECTOR_CUT_NOT_FOUND` (404).
  - `PUBLISH_DEMO_DISABLED` (403).
  - `PUBLISH_NEEDS_YOUTUBE` (403).
  - `PUBLISH_CUT_NOT_READY` (409).
  - `PUBLISH_NO_CHANNEL` (409): not in the brief. It's YouTube's `youtubeSignupRequired`,
    a Google account with no YouTube channel, which judges may well hit.
- `DirectorCutId` type added in `ids.ts`.

### AI service
- `POST /v1/director/publish-copy` (`writeDirectorPublishCopy`): DIRECTOR_MODEL writes
  the post from:
  - the cut's plan: title, format, summary and every script line (the script lines show
    which language the Short is in);
  - the title the member gave their cut;
  - the original's title and channel, when YouTube still shows it.

  It's budgeted through `app/usage.py` as `director-publish` under a new
  `DIRECTOR_TOKENS_PER_PUBLISH_COPY` (default 20000; added to the settings,
  `.env.example` and `docs/environment.md`). Errors: AI_BUDGET_EXCEEDED,
  UPSTREAM_UNAVAILABLE when Gemini fails, and DIRECTOR_CUT_NOT_FOUND unless it's the
  caller's cut.
- The model's output type, `PublishCopyDraft`, has no list bounds because Vertex refuses
  minItems/maxItems. `tidy` in `app/publish_copy.py` holds the draft to the contract:
  - removes `<`, `>` and `#Shorts`;
  - shortens text at a word boundary;
  - keeps each hashtag once, as a single word (letters, digits and marks, in any script);
  - falls back to the cut's own title when none is left.
- `GET /v1/director/cuts/{cut_id}` (`getDirectorCut`), for the API to read a cut.

### API (`apps/api/src/modules/publish`)
- `upload` checks in this order, so nothing reaches YouTube that shouldn't:
  1. The demo account (`context.demo`) gets PUBLISH_DEMO_DISABLED.
  2. Google sign-in off gives FEATURE_DISABLED.
  3. The cut is read through the AI service (DIRECTOR_CUT_NOT_FOUND).
  4. A cut that's already published is returned as it is.
  5. The cut's video is opened from storage through the storage seam
     (`FilesService.readUrl`, a presigned read) and streamed with `fetch`, never
     buffered. PUBLISH_CUT_NOT_READY when the file isn't the caller's, isn't checked yet,
     or is gone from storage.
  6. The member's Google account (`auth.account`) must carry `youtube.upload`, else
     PUBLISH_NEEDS_YOUTUBE.
  7. The access token comes from better-auth's `getAccessToken`, which refreshes it. A
     refresh Google refuses also gives PUBLISH_NEEDS_YOUTUBE.
  8. Then: claim the cut, upload, and record the result.
- The claim is `updateMany … WHERE publish_status IN (none, failed) OR (uploading AND
  updated_at older than 15 min)`. A double click or two tabs upload once, and a publish
  cut off by a restart can be retried.
- `youtube-upload.ts` does a resumable `videos.insert`
  (`uploadType=resumable&part=snippet,status`) with `selfDeclaredMadeForKids: false` and
  category 22. The PUT streams the file with a Content-Length (`duplex: "half"`). The
  upload URL comes from `YOUTUBE_API_URL` (`…/youtube/v3` becomes
  `…/upload/youtube/v3/videos`), so there's no new env var.
- It records the `status.privacyStatus` YouTube answered, not what was asked. Then it
  calls `AnalyticsService.record("published", {userId, videoId, detail: {youtubeVideoId,
  asked, privacyStatus}})`.
- A failed upload marks the cut `failed`. YouTube's answer maps to codes:
  - 401 or `insufficientPermissions` → PUBLISH_NEEDS_YOUTUBE.
  - `youtubeSignupRequired` → PUBLISH_NO_CHANNEL.
  - anything else → UPSTREAM_UNAVAILABLE.
- `copy` calls the new `ShortsService.credit(videoId)`: the original's title and channel
  from YouTube (`part=snippet`), cached for an hour like the video read, and null once
  YouTube no longer shows it. `ShortsService`'s cache, feature check and error mapping
  are now in one private `cached()` helper.
- Google sign-in now asks for `accessType: "offline"` so Google returns a refresh token.
  The web asks for `youtube.upload` separately, when the member first publishes
  (`linkSocial`).
- The comment in `apps/api/src/auth/demo.ts` now says publishing refuses the demo
  account with PUBLISH_DEMO_DISABLED (the brief's code). The demo branch's comment said
  DEMO_ACCOUNT_LOCKED.

### Mock Google (`packages/fake-google`, test fixture only)
- `oauth.ts`: Google sign-in.
  - The authorization endpoint consents for the `login_hint` account and adds the scopes
    granted before, like `include_granted_scopes`.
  - The token endpoint takes a code or a refresh token and returns an RS256 ID token.
  - `/oauth2/v3/certs` serves the signing key.
- `youtube-upload.ts`: YouTube's resumable upload (a session, then a PUT).
  - It needs a token with an upload scope: 401 `authError` without a token, 403
    `insufficientPermissions` without the scope.
  - `no-channel*` accounts get 401 `youtubeSignupRequired`.
  - It checks the metadata, keeps uploads `private` unless `youtubeAudited` is set, and
    exposes `uploads` for tests to assert on.
- YouTube reads leave out ids starting `Gone`, for a video YouTube no longer shows.

### Client and web
- Client hooks:
  - `@repo/client/api/publish/copy` (`usePublishCopyMutation`): a mutation, so a refetch
    never spends Gemini tokens.
  - `@repo/client/api/publish/upload` (`usePublishMutation`): refreshes the media and
    cuts lists when it settles.
- `PublishButton` in `apps/web/src/modules/director/components/publish-sheet.tsx` opens
  a dialog with:
  - the cut's video, as a muted preview;
  - Gemini's draft in editable fields: the title (with a live `… #Shorts` preview), the
    description, hashtags as words, and the credits;
  - who can watch it (unlisted by default), with the honest note that YouTube keeps
    uploads from apps it hasn't reviewed private;
  - Gemini loaders while the post is written and while the video uploads.
- When the API answers PUBLISH_NEEDS_YOUTUBE, the sheet:
  - keeps the draft in sessionStorage;
  - calls `authClient.linkSocial({provider: "google", scopes: [youtube.upload],
    callbackURL: <page>?publish=<cutId>})`;
  - back on the page, reopens and publishes the kept draft once. A second
    PUBLISH_NEEDS_YOUTUBE shows the message instead of going round again.
- After publishing, the sheet shows:
  - "It's on YouTube, private…", using the privacy YouTube actually gave it;
  - "You asked for public, but YouTube keeps… private" when the two differ;
  - a Watch on YouTube link;
  - "already on its way" when another publish got there first.
- My media has merged, so `CutCard` now shows `PublishButton` under the status chip:
  Publish for a cut not yet published or whose publish failed, Watch on YouTube for a
  published one, and nothing while it's uploading.
- i18n: `director.publish.*` and the error messages.

## Tests (TDD evidence)

- db: I ran the new security case with my migration moved aside first. It failed with
  `permission denied for table director_cut` (42501). With the migration: 30 passed.
- ai: the new tests failed at collection (`No module named 'app.publish_copy'`) before
  the code existed. After: 5 integration and 6 unit tests passed.
- fake-google: the 8 new cases all failed before `oauth.ts` and `youtube-upload.ts`
  existed, then passed.
- api, RF5 demo case: with the demo check disabled, the test failed (`expected
  'PUBLISH_NEEDS_YOUTUBE' to be 'PUBLISH_DEMO_DISABLED'`). With it restored, it passed.
- API `test/publish.integration.test.ts`:
  - Google sign-in, against the fake Google OAuth, creates a user with a personal
    workspace (`personal-<id>`) and the 6 seeds. The test follows a browser's path:
    better-auth's redirect, the fake's consent, then the API's callback. better-auth
    calls Google's token endpoint directly, so the test sends that request to the fake,
    the same way `password-breach.integration.test.ts` stands in for HIBP.
  - RF5: the demo account gets PUBLISH_DEMO_DISABLED. Nothing is uploaded and the cut
    stays `none`.
  - RF5: a video missing from storage, or an upload not yet checked, gets
    PUBLISH_CUT_NOT_READY. Nothing is uploaded.
  - Success:
    - stores `youtubeVideoId`;
    - the title ends with `#Shorts`, and the description ends with the credits and the
      original's link;
    - asking for `public` records `private`;
    - records `published` in analytics;
    - publishing again uploads nothing.
  - PUBLISH_NEEDS_YOUTUBE in each case: no Google account, no upload scope, a revoked
    token, and a refresh Google refuses. Refreshing an expired token works.
  - An account with no channel gets PUBLISH_NO_CHANNEL and the cut is marked `failed`.
  - A double publish uploads once, and a stale `uploading` is taken over.
  - Another member's cut gets DIRECTOR_CUT_NOT_FOUND.
  - The post is written with and without the original (cached the second time).
- `features-off`: FEATURE_DISABLED without Google sign-in.
  `director-without-storage`: FEATURE_DISABLED (files) with uploads off.
- Web `test/director/publish-sheet.test.tsx` (tagged `files`): Chromium against the real
  API, the mock Google and the AI stand-in. 7 cases, and `publish-sheet.tsx` is at 100%
  for statements, branches, functions and lines. `media.test.tsx` was extended for the
  button: 4 passed.

## Commands and output tails

- `bun run lint` → `✔ bunx turbo run lint`, every step ✔. knip passed once I un-exported
  six contract constants nothing used.
- `bun run check-types` → `Tasks: 24 successful, 24 total`.
- `bun run type-coverage` → every workspace ✔, once the fake's upload body read was
  typed.
- `bun run test` → webhooks' port test timed out at 15 s under machine load (load average
  about 50). On its own, `bun run --filter @repo/webhooks test` gave
  `Tests 24 passed (24)`. The other unit suites passed (contracts 51, client 86,
  fake-google 18, i18n 11, and the rest).
- `bun run --filter @repo/db test:integration` → `Tests 30 passed (30)`.
- `bun run --filter @repo/api test:integration:files` → `Tests 26 passed | 141 skipped`.
- `bun run --filter @repo/api test:integration` → `2 failed | 139 passed | 26 skipped`.
  The 2 failures are `account deletion › removes the personal workspace and its data` and
  `won't leave a shared workspace without an owner`. Both expect `plans: 1` and get 7
  (the 6 copied seeds plus 1). This branch doesn't touch that file. See Concerns.
- `bun run --filter @repo/ai coverage` → `322 passed`, `TOTAL … 100%`.
- `bun run --filter @repo/{client,contracts,fake-google,ai-client} coverage` → all pass.
- `bun scripts/coverage.ts`:
  - None of this branch's files is short of 100%.
  - The web files show "no test loads it" only because the web suites weren't in that
    merged run. The publish-sheet run above measured 100%.
  - It still lists `apps/api/src/auth/auth.ts` branch 139 and `procedures.ts` lines
    249–275 (the `fresh` and `orgAdmin` builders). This branch doesn't touch those lines.
- `bun run gen` → no drift.
- One full run hit a Postgres crash on the stack ("database system is in recovery
  mode"). I reran the affected suites; the numbers above are from the clean reruns.

## Decisions the brief didn't make

- `updated_at` is in the column grant, for taking over a stale upload. Prisma writes it
  on every update anyway.
- Two error codes the brief didn't list: `PUBLISH_NO_CHANNEL` and
  `DIRECTOR_CUT_NOT_FOUND`.
- `credits` is part of the upload input because the sheet edits it. The API builds the
  description with the shared `youtubeDescription`.
- The API reads the cut through the AI service (`getDirectorCut`), which owns cuts and
  plans. Per the ruling, the API writes only the publish columns.
- No new env var for the upload endpoint: it's derived from `YOUTUBE_API_URL`.
- The post is a mutation (each one costs Gemini tokens). When Gemini fails, the member
  writes their own.
- A cut that's `uploading` shows no Publish button. The API takes over a stale one after
  15 minutes.

## Concerns

1. Two account-deletion cases in `api.integration.test.ts` fail, and as far as I can
   tell they fail on origin's base too: they count the workspace's plans without the
   seeds. This branch doesn't touch them, but someone should look.
2. YouTube upload quota: each `videos.insert` costs a large share of the default 10,000
   units a day. The 5 per hour per user limit doesn't protect the project-wide quota.
3. The real Google OAuth client needs YouTube Data API v3 enabled and the
   `youtube.upload` scope added to the consent screen. Until the app passes Google's
   audit, every upload is private. The UI says so.
4. Coming back from Google depends on `?publish=<cutId>` surviving the round trip on
   `/media` (better-auth's `callbackURL`). The test checks the navigation it captures,
   not a real Google.

---

## Fix round 1 (review `task-2.4-review-1.md`, controller rulings)

Status: DONE_WITH_CONCERNS (the browser tests are written but weren't run locally after
the fix; see "Not run").

Started from `29febf9`, the controller's rebase onto `71d4f57`. Commits
`29febf9..8d3df6f`:

- `6c836dc` fix(ai): keep a post within YouTube's description limit in bytes, and answer before the API stops waiting
- `8c3c16c` feat(api): cap Director's YouTube uploads a day, and say so when the quota is spent
- `a065aa0` fix(web): keep the publish sheet saying how it went while My media catches up
- `8d3df6f` refactor(fake-google): say why an upload is refused in one place

### What each item became

- **Important 1 (the sheet's states vanished once My media refreshed).** `PublishButton`
  now always renders the `Dialog`; only the trigger (`Trigger`) switches on the cut's
  status. To make the bug reproducible, the browser tests' AI stand-in
  (`apps/web/test/fake-ai.ts`) now overlays a cut's publish status, YouTube id and
  visibility from the tests' database. Both the cut list and the single-cut read get it,
  so My media sees the cut change once a publish lands, as it would with the real AI
  service. New test, "keeps saying how it went while My media catches up with the cut":
  it publishes from the real `MediaPage`, waits for the list to be fetched again and the
  card to read "Private on YouTube", then checks the success message and the "kept it
  private" note are still visible. Against the previous component it failed (red run
  below).
- **Important 2a (daily cap).** `PUBLISH_DAILY_LIMIT = 5` sits in
  `packages/contracts/src/api/publish.ts` with the other publish limits. The counter is
  `apps/api/src/modules/publish/daily-allowance.ts`: a Redis key
  `publish:uploads:<UTC date>`, taken with one MULTI of INCR and EXPIREAT so it expires
  at the next UTC midnight. Over the cap, it decrements again and refuses.
  - The place is taken after the access token and before the claim.
  - It's given back when the claim goes to another publish, and when YouTube refuses the
    upload.
  - Giving it back sets the expiry again, so a day that has ended can't leave a key with
    no expiry behind.
- **Important 2b (quota errors).** `publishErrorOf` maps `quotaExceeded`,
  `dailyLimitExceeded`, `uploadLimitExceeded` and `rateLimitExceeded` to the new
  `PUBLISH_QUOTA_EXHAUSTED` (429), the same code the cap gives. The message tells the
  member the video is saved and to publish it again tomorrow.
  - The mock Google has `exhaustQuota(on)`: both reads and uploads then answer 403
    `quotaExceeded`. It has its own fake-google test.
  - Integration tests cover three cases. At the cap: refused before YouTube, nothing
    uploaded, the cut stays `none`, the count unchanged. With the last place left: it
    publishes, the count reaches the cap, and the key's TTL is at most a day. With
    YouTube's quota spent: PUBLISH_QUOTA_EXHAUSTED, the cut is `failed`, and the place is
    given back.
  - The "under way" test also checks a lost claim gives its place back.
- **Minor 1.** The claim sets `updatedAt: new Date()` itself. New test: an hour-old cut
  published twice at once is uploaded once and counts once. I checked whether this test
  fails without the explicit `updatedAt`, and it doesn't: Prisma's `@updatedAt` does
  refresh the column inside `updateMany`. Setting it explicitly still makes the intent
  visible, and the test pins the behaviour.
- **Minor 2.** `copy` turns an UPSTREAM_UNAVAILABLE from `ShortsService.credit` into
  `original: null`. Test: with the mock Google's quota spent, the post is still written,
  with `original: null`. (`ShortsService` maps YouTube's errors in one private
  `cached()`, so that's where UPSTREAM comes from.)
- **Minor 3 (parked).** A comment above the claim in `readyToSend` explains it: a crash
  after YouTube took the video, but before the cut is marked published, can mean a second
  copy after the stale window. That's accepted as rare.
- **Minor 4.** `COPY_TIMEOUT_SECONDS` is now 25 (it was 30). A test reads ai-client's
  default `timeoutMs` from `packages/ai-client/src/index.ts` and asserts the model's
  timeout is at least 5 s under it.
- **Minor 5.** `tidy` cleans the fallback title the same way as Gemini's (no brackets,
  no `#Shorts`, spaces collapsed). Test: `" <> "` falls back to the cut title
  `"My <best> look #Shorts"`, which becomes `"My best look"`.
- **Minor 6.** There is now one limit, counted in UTF-8 bytes on both sides.
  - The contract exports `fitsYouTube(copy)`. The upload input's refine uses it, and so
    does the sheet's `draftSchema`.
  - `tidy` shortens the description to the bytes left once the hashtags, the credits and
    the longest link are added. The link format is mirrored in Python, and the test
    composes the description exactly as `youtubeDescription` does.
  - Tests: an AI unit test with a long Japanese post, which fits within 5,000 bytes and
    ends at a word; a contracts test of `fitsYouTube`; and a browser test where a long
    Japanese description shows the inline "won't take this" message.
- **Minor 7.** `PublishBody` takes the kept draft once, from its mount, and calls
  `onResumed`, which clears `resumed` in `PublishButton`. Opening the sheet again starts
  from Director's post. The browser test closes the sheet with Escape after the resumed
  failure, reopens it, and checks it shows Gemini's title with no re-send.
- **Minor 8.** `stash` and `unstash` are wrapped in try/catch. A blocked `setItem` still
  goes to Google, and a corrupted kept value opens with Director's post. Two browser
  tests cover these.
- **Minor 10.** The wrap of the `youtube.ts` doc comment is fixed. The
  `MAX_TITLE`/`MAX_HASHTAGS` aliases are gone; the tests import the `MAX_PUBLISH_*`
  constants.
- The browser tests reset the day's allowance before each test (a `resetPublishAllowance`
  command), since Valkey database 18 outlives a run. The API integration tests do the same
  in a `beforeEach`.

### TDD evidence

- AI: the new tests failed at collection (`YOUTUBE_DESCRIPTION_MAX_BYTES` didn't exist)
  before the change, then all 9 passed.
- API: the new integration tests failed first:
  - files suite: `3 failed | 10 passed` (the hour-old double publish, the cap, YouTube's
    quota);
  - core suite: `1 failed` (the copy while YouTube can't be read).
  After the change: `13 passed` in each suite.
- Web (the one browser run, before the owner's instruction): the new tests run against
  the previous component (`git show HEAD:…/publish-sheet.tsx`) gave
  `4 failed | 7 passed`. The four were: "keeps saying how it went while My media catches
  up", "asks Google … on the way back" (the reopen part), "still asks Google when there's
  nowhere to keep the draft", and "checks a long post against YouTube's limit in bytes".
  The fixed component was then put back.

### Commands and output tails

- `bun run gen` → exit 0, no drift (`git status` empty after it).
- `bun run lint` → `✔ bunx turbo run lint`. The first run caught a 62-line function in
  the fake's upload (`noExcessiveLinesPerFunction`); I split it (`8d3df6f`) and reran
  clean.
- `bun run check-types` → exit 0.
- `bun run test` (non-browser unit) → exit 0.
- `bun run --filter @repo/api test:integration -- publish features-off director-without-storage`
  → `Tests 13 passed | 13 skipped`.
- `bun run --filter @repo/api test:integration:files -- publish director-without-storage`
  → `Tests 13 passed | 7 skipped`.
- `bun run --filter @repo/ai test` → `177 passed`. `test:integration -k "post or cut_is_read"`
  → `5 passed`. `publish_copy.py` at 100% lines and branches.
- `@repo/fake-google` coverage → 19 passed, 100% statements, branches, functions and
  lines. Contracts → 52 passed.

### Not run locally (the owner's instruction: the machine is overloaded)

These browser tests in `apps/web/test/director/publish-sheet.test.tsx` were written but
not run locally after the fix:

- "keeps saying how it went while My media catches up with the cut"
- the reopen part of "asks Google to allow YouTube uploads, then publishes what was kept"
- "still asks Google when there's nowhere to keep the draft"
- "opens with Director's post when what was kept can't be read"
- "checks a long post against YouTube's limit in bytes, as the API will"

The existing publish-sheet and media tests now run against the changed component and the
AI stand-in that reads the database. They weren't rerun locally either. All of these run
in CI. The component's 100% coverage was last measured before this round.

### Concerns

- The ruling asked for a test that "publishes from the real My media page". The test
  needed the browser tests' AI stand-in to read publish status from the database
  (`startFakeAi(databaseUrl)`), so that stand-in now holds a small `pg` pool.
- Minor 9 (a Google account with a different email can't be linked) is parked as
  ruled, unchanged.
- One edge is left in `tidy`: if both Gemini's title and the cut's own title clean down to
  nothing (a cut titled only `<>` or `#Shorts`), PublishCopy's `min_length=1` refuses, and
  `copy` answers 500. The sheet's own fallback for a failed copy is unaffected.

---

## Fix round 2 (review `task-2.4-review-2.md`, controller rulings)

Commits `8d3df6f..c973a5f`:

- `f0e6826` fix(api): count the day's uploads on YouTube's own day, and keep a place YouTube has charged
- `ddb0afc` fix(ai): fall back to the original Short's title when neither post nor cut has one
- `54de537` refactor(fake-google): answer a finished upload from its own function
- `c973a5f` fix(web): forget ?publish once the sheet opens, and put focus back on the card

How each ruling was met:

- **Important 1 (keep the place once YouTube opened the session).**
  - `YouTubeUploadError` now carries `sessionOpened`. It's false for errors from starting
    the session and true from the PUT on, including an unreachable PUT.
  - The service gives the place back only for an error raised while starting the session,
    before it opened. A parse failure after the PUT keeps the place too.
  - The mock Google has `breakUploads(on)`, which answers the PUT with 503 backendError.
  - Integration tests cover both sides. A broken PUT keeps the count at 1 and the cut ends
    `failed`. YouTube's quota being spent at session start gives the place back (count 0).
  - Red check: forcing the give-back on every failure makes the first test fail
    (`expected +0 to be 1`).
  - Unit tests cover the `sessionOpened` flag for each phase.
- **Important 2 (YouTube's quota day).**
  - `apps/api/src/modules/publish/quota-day.ts` uses `Intl`, America/Los_Angeles. No
    Temporal (not available) and no new dependency.
  - `quotaDay(now)` gives the Pacific date; `nextQuotaDay(now)` gives the next Pacific
    midnight in epoch seconds.
  - The counter key is `publish:uploads:<Pacific date>` and expires at the next Pacific
    midnight.
  - Unit tests cover both DST boundaries in 2026 (8 March and 1 November, either side of
    midnight) and a year end. They failed first (module missing).
  - The contract's comment and `docs/how-it-works.md` (a new "day's allowance" paragraph)
    are updated.
- **Minor 1.** `DailyAllowance.keepIf(day, claim)` gives the place back when the claim
  answers false or throws. Integration test: a `claim` that rejects gives INTERNAL, count
  0, nothing uploaded.
- **Minor 4.** `giveBack` logs and swallows its own failure. The upload's failure path
  uses `Promise.allSettled` for `failed()` and the give-back, logs a failed `failed()`,
  and always rethrows `publishErrorOf(error)`.
  - Integration test: `failed()` rejects while YouTube's quota is spent, and the member
    still gets PUBLISH_QUOTA_EXHAUSTED.
  - Integration test: a Redis `multi` that throws inside `giveBack` resolves, and the
    count stays.
- **Minor 2.** On the way back from Google, `PublishButton` calls
  `router.replace("/media", { scroll: false })`. The `linkSocial` callbackURL is now
  `/media?publish=<id>`, since the sheet lives in My media.
  - Browser test: the URL becomes `/media`. Rendering again at that URL shows the Publish
    button with no sheet and no new `publish/copy` request.
- **Minor 3.** The trigger is wrapped in a `span.contents`. The dialog's `finalFocus`
  returns the link or button inside it, or the card's heading (a new required `heading`
  ref; `CutCard`'s title is now an `h3` with `tabIndex=-1`).
  - Browser tests: after a publish from My media, Escape moves focus to "Watch on
    YouTube".
  - A publish under way (trigger gone) moves focus to the card's heading.
  - Closing unpublished moves focus back to Publish.
- **Minor 7.** The browser tests' AI stand-in parses cut bodies and database rows with
  zod (no casts). A failed overlay query answers 500 INTERNAL instead of hanging.
- **Title edge.** `tidy(draft, *fallback_titles)` tries Gemini's title, then the cut's,
  then the plan's original title, each cleaned. When none is left it raises
  UPSTREAM_UNAVAILABLE (gemini).
  - Unit tests cover the plan-title fallback and the all-empty case; both failed first.
  - `publish_copy.py` is at 100% lines and branches.

Checks (no browser runs, per the owner):

- `bun run gen` → no drift.
- `bun run lint` → `✔ bunx turbo run lint`. The first run flagged the fake's
  61-line function; `54de537` fixed it.
- `bun run check-types` → exit 0.
- `bun run test` → exit 0.
- API publish integration: core `13 passed | 17 skipped`, files `17 passed | 7 skipped`.
- AI: `179 passed` unit, `5 passed` integration (`-k "post or cut_is_read"`).
- fake-google: 20 passed, 100% coverage.

Written but not run locally (CI runs them), all in
`apps/web/test/director/publish-sheet.test.tsx`:

- the focus assertion in "keeps saying how it went…"
- "puts focus on the card's title when the sheet closes on a publish under way"
- "drops ?publish once it has opened…"
- "goes back to the Publish button when the sheet closes unpublished"
- the existing tests, now rendered through a `Card` wrapper that supplies the heading
