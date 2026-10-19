# Polish batch report

Status: DONE_WITH_CONCERNS (concerns at the end; none block the brief)

(I wrote this in the worktree because the guard refused the shared-checkout path. It is not committed.)

Branch: `worktree-agent-a8312ffb4e1de3664`, reset to `origin/feat/mm/director-hackathon` (4f23bd5) first.
Commits: `4f23bd5..9c05cfc` (6 commits)

```
7b6ca0f feat(web): show each seed template's storyboards, Veo previews and Lyria soundtrack
710bc3b feat(web): list Veo, Lyria, Nano Banana, Gemini text-to-speech and Cloud Run on the landing
d7a553a fix(web): stop a line whose sound breaks off, and speak the first steps ahead
90989af fix(ui): let GeminiLoader render as a span inside a button
1f2a1b1 fix(web): don't show Saved after the member cancelled
9c05cfc fix(ai): run index_short's drafted callback outside the planner's retry
```

## 1. Seed media on the template page

Files: `apps/web/src/modules/director/components/shot-list.tsx`, `apps/web/src/modules/director/pages/director.tsx`, i18n `director.template.*`.

- **Shot cards.** When a shot has a working `storyboardUrl`, `ShotPicture` renders a `StoryboardCard` in place of the framing sketch. It's a 9:16 tile, `w-28`, holding the storyboard `<img>` (`loading="lazy"`, `decoding="async"`, alt "Storyboard for {title}: {scene}"). The framing sketch shrinks to an inset in the tile's top-right corner, so the "where you stand" information isn't lost. A full-tile button plays the shot's `previewUrl` in place: the `<video>` is `autoPlay muted loop playsInline`, with the storyboard as its poster. The button is labelled "Play the Veo preview of shot N" / "Pause the preview of shot N". The caption under the tile reads "Storyboard by Nano Banana", or "Preview made with Veo" while the clip plays. `ShotList` holds which preview is playing, so only one plays at a time and nothing autoplays on its own. A member's own plan (no URLs) renders exactly as before, with the `w-16` framing sketch.
- **Soundtrack.** `Soundtrack` shows a pill above "You need N shots" with a play/pause button ("Play the soundtrack" / "Pause the soundtrack") and the text "Soundtrack, made with Lyria". The music plays from an `Audio` object, with `preload` set to none and the src set afterwards so nothing loads until it's played; it loops and pauses when you leave the page. It isn't an `<audio>` element because Biome's `useMediaCaption` would require a captions track, and biome-ignore isn't allowed.
- **Expired links.** `useMediaLink(url, media)` hides an element whose link failed. `media` is `{ read: dataUpdatedAt, refresh }`, and `refresh` refetches the plan at most once a minute (`useMediaLinks` in director.tsx). A failure is keyed by URL and the time the plan was read, not by the URL alone, because a re-signed link can come back identical within the same second. Without that, the element stayed hidden after a refetch (I hit this in the tests). So a failed link triggers one refetch, the fresh link is tried once, and anything that still fails is left out: a broken storyboard falls back to the plain framing sketch, a broken preview loses its play button, and a broken soundtrack loses its player.
- **Test helper.** I added a `serveRequests(patternSource, {contentType, base64})` browser command in `apps/web/test/commands.ts` that answers matching requests with given bytes. The local stack doesn't hold the seed media keys, so the tests serve a canvas JPEG, a recorded WebM and a silent WAV at the signed storage URLs the real API produces for the seed. The fake AI returns `source: "seed"` plus the committed seed plan, and the real API signs the media keys against the stack's storage. The route handler's failing/serving logic moved into `answerAsSet` to stay under Biome's complexity limit.

Tests (`apps/web/test/director/director.test.tsx`, "a seeded template's media"):

1. A seed plan renders a lazy storyboard image per shot (it loads), with the Nano Banana credit on each card and no `<video>` until one is tapped. Tapping plays the preview (src `shot-0.mp4`, muted, loop, playsInline, actually playing) with the Veo credit. Tapping shot 2 stops shot 1 so only one plays. Pause brings the card back. The soundtrack loads nothing until played, then plays and pauses. The plan is read once.
2. A member's own plan of the same Short (`source: "user"`) shows no media, no credits, no soundtrack, and the framing sketches as before.
3. A preview link that fails (403) causes one plan refetch; the button comes back. A second failure within a minute causes no further refetch, the clip is left out and the card stays. A soundtrack that fails is removed.
4. Storyboards that won't load: one refetch, then every card falls back to the framing sketch with no credit. This test uses a second seed (WvGUjw7OwZo), because a link signed in the same second as another test's is identical and Chromium served the cached picture.

Visual check: I couldn't use playwright-cli against a real seed page. My stack serves from RustFS, where the seed keys don't exist, and signing GCS links needs credentials. So the screenshots come from a scratch browser test (deleted afterwards) that rendered seed 152Jy2c3XSM with the stand-in media on the studio background:
- `/private/tmp/claude-503/-Users-manas-madan-Desktop-code-director-editor/f1ddf0d8-5838-46aa-97e0-9a9cb55506ef/scratchpad/top.png`: the soundtrack pill, the storyboard strip and the first card (storyboard tile, inset sketch, play badge, "Storyboard by Nano Banana").
- `.../scratchpad/cards.png`: a card while its preview plays (pause badge, "Preview made with Veo").
I didn't view the real Veo/Nano Banana/Lyria media; that needs the production bucket.

## 2. Landing's Google Cloud list

`SERVICES` in `apps/web/src/modules/marketing/components/sections.tsx` now lists, in order: argon, flash, live, **tts**, **nanoBanana**, **veo**, **lyria**, storage, **cloudRun**, bigquery, youtube, signIn. New lines in `home.cloud.*`:
- Gemini text-to-speech: "Gives Director its voice while you film."
- Nano Banana on Vertex AI: "Drew the storyboard card of every shot in the templates."
- Veo on Vertex AI: "Made the preview clip of every shot in the templates."
- Lyria on Vertex AI: "Wrote each template's soundtrack."
- Cloud Run: "Runs the indexer, where Gemini watches each Short."

"On Vertex AI" for the three media models is factual: seed_media.py calls them through `genai.Client(vertexai=True)`. The TTS line names no platform. I added a new case to `home.test.tsx` that checks each name and line.

## 3. Review follow-ups

- **TTS onerror/onabort** (`lib/speech.ts`). `play()` now has one `over` handler for `ended`, `error`, `abort` and the play() rejection. If `playing === audio`, it clears `playing` and `current`, and falls back to the browser voice only if the line never started (tracked with `started`, set on `playing`). A line already superseded does nothing, so a late `ended` from an old line no longer clears the newer line's `current`. New browser test (`test/director/lib/speech.test.tsx`, it.each error/abort): a line playing in Director's voice whose audio errors or aborts midway stops being "said", isn't repeated in the browser voice, and the next line plays normally. The existing "can't be played → browser voice" test still passes.
- **Warm the cache** (`hooks/use-live-director.ts`, `lib/cues.ts`). `stepLines(steps, words)` in cues.ts returns each step as Director says it ("Action! …" first); `stepCue` uses it too, so the two can't drift. `useStepsAhead` asks `voice()` once for the opening shot's first 4 step lines (`STEPS_AHEAD`), only when `speak` is true (`memory.speak && !calling`, so never on a live call), and swallows failures (the line is asked for again when it's said). It warms only the step lines, not the greeting: the greeting is said the moment the screen opens, so warming it would only double the request. Warmed links also land in `useDirectorVoice`'s in-memory map, so the first "Action!" plays straight away. Tests: a `stepLines` unit test in cues.test.ts, and a live-hooks browser test checking that steps are asked for on open, not on a call, only the first 4, only once, and that a failing one is tolerated. I gave the existing `onSet` helper a shot without steps, so its "failing" case still checks that "Cut!" is asked for: a warm-up failure would otherwise rest the voice first.
- **GeminiLoader `as="span"`** (`packages/ui`). It takes `as?: "div" | "span"` (default div), and its props are now `React.HTMLAttributes<HTMLElement>`; nothing passed a ref. directors-cut.tsx's Send button uses `as="span"`. I added a plain browser test (`gemini-loader.test.tsx`) instead of a new story, to avoid new visual baselines (the ui rule). The existing stories pass.
- **h1**: `truncate` changed to `line-clamp-2`.
- **`vi.restoreAllMocks()`** in director.test.tsx moved into a file-level `afterEach`. The brief's line 932 doesn't exist; the only inline one was in the scroll test.
- **Editor cancel** (`pages/edit.tsx`): `if (signal.aborted) return;` before showing Saved. The files contract has no delete, so `save-cut.ts`'s `signal` doc now says what a late cancel leaves: after completeUpload, a ready file with no cut (worker cleanup only removes pending files); once saveCut is in flight, the cut is saved and shows in My media. New files-profile test in edit.test.tsx: `fetch` is wrapped so Cancel is clicked just as `/rpc/director/saveCut` goes out. The cut is recorded (media() has it), the editor is back, and there's no Saved dialog.
- **`index_short` drafted** (`apps/ai/app/indexing.py`): I chose to call it outside the try rather than only document it. The `_repaired(...)` call moved into the `try`'s `else:`, so an error from `drafted` (or from `repair_plan`) goes straight to the caller and isn't treated as the planner failing. The docstring says so. New unit test in `tests/test_units.py`, using pydantic-ai's `TestModel` (a `CountingTestModel` subclass that counts runs): a `drafted` that raises `TimeoutError` is called once, the planner runs once, and the fallback runs zero times.

## TDD evidence (failing first)

- Template page: `test/director/director.test.tsx`: 3 failed | 16 passed before the implementation was complete. "Soundtrack, made with Lyria" was not found, and the plan was read 1 time where 2 were expected. That run picked up a half-written shot-list, so it also logged `onFailed is not a function`.
- Landing: `home.test.tsx`: `× lists every Google Cloud service…` (expected HTML to contain 'Gemini text-to-speech').
- Speech: test run against HEAD's speech.ts: `× stops saying a line whose sound breaks off midway (error)`, `(abort)`: 2 failed | 13 passed.
- cues: `TypeError: stepLines is not a function`.
- Warm-up: test run against HEAD's use-live-director.ts: `× has the opening shot's steps spoken ahead…`: 1 failed | 18 passed.
- GeminiLoader: `AssertionError: expected 'DIV' to be 'SPAN'`.
- Editor cancel: `× shows nothing saved when the member cancels as the cut is being recorded`: the Saved dialog covered the editor ("Save video" not found).
- ai: `assert (len(calls), planner.runs, fallback.runs) == (1, 1, 0)` failed with `4 != 1` (drafted ran on every retry plus the fallback).

## Checks (on stack 4: `bun run setup --stack 4`, plus `bun scripts/services.ts up --files` for RustFS; `bun run db:down` at the end)

- `bun run lint`: every step passes except `bunx biome check .`. The failures it reported in my files (one function too long, one too complex, one Promise used as a condition) are fixed. Re-running `bunx biome check apps/web packages` leaves only the deleted scratch test's errors. A finding in `scripts/image-scan.test.ts` (noTemplateCurlyInString) comes from another file I didn't touch.
- `bun run check-types`: 24 successful.
- `bun run test` (every unit suite): 22 tasks successful, exit 0 (ai: 169 passed).
- `bun run --filter @repo/ai lint`, `check-types`: clean (0 errors). `bun run --filter @repo/ai coverage`: 312 passed, TOTAL 100%, `app/indexing.py` 100%.
- Web browser tests for what I touched: director, speech, live-hooks, shoot and use-director-voice gave 73 passed / 4 skipped. After the last fixes, director + live-hooks + speech gave 53 passed. The editor files profile (`test:integration:files test/director/edit.test.tsx`) gave 12 passed / 6 skipped.
- `bun run --filter @repo/web coverage` (every web suite): 571 passed, 6 failed. Each failure was a 30-second timeout in an unrelated area (security, avatar, library) or a "Service Unavailable" while the machine was loaded. Re-run on their own: director, library and security gave 39/39 passed, and edit passed. `avatar.test.tsx › says so when storage refuses the upload` still fails on stack 4 because it hard-codes RustFS's default port (`refuseNextPut(":59000/")`), while stack 4's RustFS is on 59400. That's an existing problem with the test, not from this change. Coverage from that run: shot-list.tsx, director.tsx, speech.ts, use-live-director.ts, cues.ts, sections.tsx and directors-cut.tsx have no uncovered lines, branches or functions. edit.tsx's only gaps are the existing mp4/webm `extension` branches (lines 127 and 201), left uncovered because the full run's flaky "saves the video" and MP4 tests didn't complete. My new `signal.aborted` branch is covered both ways.
- `packages/ui` gemini-loader stories and test: 10 passed.
- `bun run gen`: no drift beyond the regenerated `en.d.json.ts` for the new keys.

## Decisions beyond the brief

- The storyboard tile replaces the framing sketch on seed cards, and the sketch moves into the tile's corner.
- Media-failure refetches are limited to one per minute, and a failure is keyed by when the plan was read (explained above).
- The soundtrack plays from an `Audio` object rather than an `<audio>` element, because of the captions rule.
- The warm-up covers the opening shot's first 4 steps but not the greeting.
- The `index_short` fix moves the call rather than only documenting it.
- For the save-cut cancel, I only documented the leftover file, because the files contract has no delete.

## Concerns

1. I couldn't check the real media visually (it needs the GCS bucket or signed links, which need credentials). The layout was checked with stand-in media only.
2. `apps/web/test/commands.ts` gained `serveRequests` and the `answerAsSet` refactor. The brief didn't name this file, but no other agent's area was touched.
3. The web suite is flaky under machine load (Prisma transaction timeouts, 30 s waits), and `avatar.test.tsx` hard-codes port 59000 so it fails on any stack other than 0.
4. The storyboard strip on an 11-shot seed (152Jy2c3XSM) overflows on a phone-width screen (shot 11 is cut off), as seen in the screenshot. This existed before this change and is outside the brief.

---

# Fix round 1 (review task-polish-review-1.md)

Status: DONE_WITH_CONCERNS. Base is the controller's rebase (HEAD 0ff63b4 on 71d4f57).
New commits: `0ff63b4..4f57340`

```
bd82722 fix(web): keep a seed's media links through a plan read again, and let the strip scroll
4f57340 docs(web): say which lines Director speaks ahead
```

## Important 1: sticky media links (shot-list.tsx `useMediaLink`, director.tsx `useLoop`)

- **`useMediaLink`.** It keeps the first link it was given (`held`, in state) and ignores the re-signed links that later reads of the plan bring. When the held link fails, it records the plan read time (`failedAt`) and asks for a re-read through `refresh()`. Until a plan read after that arrives, it returns no link, so nothing broken is shown. Once a later read arrives, it adopts that read's link and clears `failedAt`; this is a guarded set-state during render, React's pattern for state derived from props. The hook lives per card (storyboard and preview) and per soundtrack, so a link is keyed by that element's identity, not by the URL string.
- **`useLoop` cleanup.** It now calls `setPlaying(false)` after it aborts the listeners and pauses. A torn-down player can no longer leave the button saying it's playing.
- **Tests** (director.test.tsx):
  - "keeps the soundtrack, a preview and the storyboards as they are when the plan is read again". The page is rendered with the site's `<LiveUpdates />`. The test starts a preview and the soundtrack, waits until more than a second has passed so re-signed links differ, and sends `director.changed` on the org channel (retried until the page's stream hears it) until the plan is read again. It confirms a fresh read has different links, then asserts: the soundtrack is still playing, its toggle is still `aria-pressed="true"`, the preview `<video>` keeps the same src and is still playing, and every storyboard `<img>` src is unchanged.
  - The "reads the plan again once…" test now waits a second before the first play. A MutationObserver records each preview `<video>` src, and the test asserts that the retry after the refetch used a second, different link (the fresh one).
- **Red run:** the new test against the old `shot-list.tsx`, with the old `director.tsx` plus only the aria-pressed change, failed with `expected true to be false` because the soundtrack stopped on the re-read.

## Important 2: strip at phone width (shot-list.tsx `Storyboard`)

The `<ol>` is now `flex h-14 snap-x gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none]`, and each `<li>` keeps `min-w-9` (36 px) and adds `snap-start`. Test "keeps every shot of a long short within reach in the strip on a phone": at a 360×780 viewport with 11 shots, the page doesn't scroll sideways (`documentElement.scrollWidth <= innerWidth`). After scrolling, the 11th button sits inside the strip's box, is at least 36 px wide, and can be pressed. Red run on the old code: `expected 452 to be less than or equal to 360`.

The scrollbar is hidden, so on a desktop with no trackpad the strip scrolls only by keyboard focus or shift-scroll. That's an accepted trade-off for a fixed 56 px row.

## Minor 5

The soundtrack toggle keeps a stable label, "Play the soundtrack", and uses `aria-pressed={playing}`; the icon still switches between play and pause. I removed the unused `pauseSoundtrack` key and regenerated `en.d.json.ts`. The tests now assert `aria-pressed` false→true→false.

## Minor 6

`useStepsAhead`'s docstring now says the lines are the ones the hook was first given: the shoot screen mounts it afresh for each shot, so a screen that kept it across shots would warm only the first.

## Checks (stack 4, core services; stopped at the end)

- Browser tests: `test:integration test/director/director.test.tsx test/director/live-hooks.test.tsx test/director/lib/speech.test.tsx test/director/shoot.test.tsx` passed: 4 files, 71 passed, 4 skipped. After that run, biome reformatted whitespace in director.test.tsx, and I didn't run the tests again.
- `bun run check-types`: 24 successful.
- `bun run test`: 22 successful.
- `bun run lint`: every step passes except `bunx biome check .`, whose only remaining finding is `scripts/image-scan.test.ts:279` (noTemplateCurlyInString), an existing problem in a file I didn't touch. `bunx biome check apps packages` is clean.
- `bun run gen`: no drift.

## Concerns

- I didn't rerun full web coverage this round. The new lines all run in the tests above: sticky-link adoption in the refetch-once and broken-storyboard tests, and the cleanup in the refetch test.
- As before, the real GCS media wasn't viewed. Minors 3 and 4 are parked as ruled.

Note: the owner's instruction to stop running browser tests locally arrived after this round's browser run had finished. All of this round's browser tests (the two new ones and the updated ones in director.test.tsx) ran once locally and passed. After that, biome reformatted whitespace in director.test.tsx, and I didn't run them again. No further browser runs were made, and CI will run them.

---

# Fix round 2 (task-polish-review-2.md)

Status: DONE_WITH_CONCERNS. Commit: `4f57340..8699edf` (one commit).

- **N1:** `useMediaLink.failed()` first checks whether the plan has brought a newer link than the one in use (`url !== held`). If it has, it switches to that link at once and returns `true`, with no `refresh()`. Only when the newest link itself fails does it set `failedAt`, call `refresh()` and return `false`. A preview whose `<video>` errors keeps playing (`onPlaying(false)` runs only when `failed()` returns false), so it carries on from the fresh link. Storyboards and the soundtrack switch in the same way; a soundtrack that switches needs another tap.
  - New test, "plays from the plan's freshest link when the one it was first given has run out": rendered with `<LiveUpdates />`. It reads the first read's `X-Amz-Date` from a storyboard src, nudges a second read after more than 1 s, and then fails every link carrying the first read's `X-Amz-Date` with a 403. It plays preview 2 and expects it to play from a link with a different date: the `<video>` src went from the first read's link to the second's. The plan-read count must not change.
  - I extended `clipsShown` to also record `src` changes on an existing `<video>`.
- **N2:** the strip buttons are now `outline-none focus-visible:ring-2 focus-visible:ring-studio-foreground focus-visible:ring-inset`, the same as the preview button.
- **N3:** `useShownInStrip(watching)` scrolls only the strip (`scrollLeft`), and only when `watching` changes after mount, so nothing moves on first render. I didn't use `scrollIntoView({block: "nearest"})`, because it also scrolls the page vertically to reach the strip, and that would fight `scrollToPlayer`'s smooth scroll to the top. It uses the same nearest rule along the strip: no change if the button is already in view, otherwise the smallest scroll that brings it in. The 360 px strip test now checks that `scrollLeft` is 0 on open and that shot 11 is out of view. It then watches shot 11 from its card and expects it inside the strip, then shot 1 from its card and expects it in view, then taps shot 2 (already in view) and expects `scrollLeft` unchanged.
- **N4:** `clipsShown` calls `onTestFinished(() => watch.disconnect())`.

Checks: `bun run lint` exit 0. `bunx biome check .` still lists only the existing `scripts/image-scan.test.ts:279` finding, in a file I didn't touch. `bun run check-types`: 24/24. `bun run test`: 22/22. `bun run gen`: no drift.

Browser tests were written but not run locally, on the owner's instruction (CI runs them):
- New: "plays from the plan's freshest link when the one it was first given has run out".
- Changed: "keeps every shot of a long short within reach in the strip on a phone", plus every test that uses `clipsShown`.

Concerns:
- None of these browser tests has run anywhere yet.
- The N1 test assumes one plan read signs every link within the same second. The API signs them in parallel inside one request, so a link signed in the next second is possible but unlikely.
- Coverage for the new branches depends on CI's browser run.
