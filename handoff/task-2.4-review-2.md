# Task 2.4 review 2: fix round 1 (29febf9..8d3df6f)

I read the diff, the files around it at 8d3df6f, and the round's report. Focused checks I ran (read-only, no browser):
- `bun run --filter @repo/contracts test -- src/api/publish.test.ts`: 9 passed.
- `bun run --filter @repo/api test -- src/modules/publish`: 10 passed.
- `bun run --filter @repo/ai test -- tests/test_publish_copy.py`: 9 passed.
- A 3,000-case fuzz of `tidy` (Latin, kana, Devanagari, emoji, newlines, brackets, empty parts) measured against the TS `youtubeDescription` rule. Worst case 4,999 bytes, never over 5,000, no exceptions.

I didn't run the browser tests or the integration suites. CI runs them.

### Per-finding verdicts

- **Important 1 (keep the sheet mounted): Addressed.** The status branches now live only in `Trigger` (`apps/web/src/modules/director/components/publish-sheet.tsx:329-344`). `PublishButton` always renders the `Dialog` (`:352-375`). `PublishBody` gets its success state from `publish.data`, not from the `cut` prop, so the refetched cut can't replace it. Its effects key on `cut.id` and `cut.fileId`, which don't change. `CutCard` is keyed by `cut.id` (`pages/media.tsx:181`), so the button stays mounted when the list refetches. There's a new browser test that publishes from the real `MediaPage` (`apps/web/test/director/publish-sheet.test.tsx:105`). I haven't run it; CI will. The dialog-stays-mounted pattern has two small side effects, listed as New Minor 2 and 3.
- **Important 2a (daily cap): Partially addressed.**
  - What's right: the take is atomic. One MULTI runs INCR and EXPIREAT (`apps/api/src/modules/publish/daily-allowance.ts:39-42`), and a take over the cap is refused and decremented (`:43-46`). The cap can't be exceeded. Every success needs an INCR reply of 5 or less, and a refused take only inflates the count until its own DECR.
  - The place is taken after the access token and before the claim (`publish.service.ts:179-186`). A lost claim gives it back (`:185-187`) and returns early, so nothing gives it back twice. An upload failure gives it back once, alongside `failed` (`:140-146`). A success, or a failure of `published()`, keeps the place, which is correct. Giving a place back after midnight is safe: DECR followed by an EXPIREAT in the past deletes the key, so nothing negative or permanent is left behind.
  - Gaps: the give-back covers failures where something did reach YouTube (New Important 1). A `claim` that throws leaks a place (New Minor 1). The UTC day doesn't line up with YouTube's quota day (New Important 2). The last one is a ruling-level point for the controller.
- **Important 2b (quota errors become PUBLISH_QUOTA_EXHAUSTED): Addressed.** `QUOTA_REASONS` holds all four reasons (`publish.service.ts:58-65`). The check comes before the 401 / insufficientPermissions branch (`:74-76`).
  - The code is 429 (`packages/contracts/src/errors.ts:99-103`), it's in the contract's error list, the generated AI and jobs copies are regenerated, and the message is translated (`packages/i18n/messages/en.json:387`).
  - A unit test covers each reason (`publish.service.test.ts:33-44`), and the mock Google's `exhaustQuota` drives an integration test (`publish.integration.test.ts:572`).
  - Per reason: `quotaExceeded` and `dailyLimitExceeded` read exactly right. `uploadLimitExceeded` is the member's own channel limit. "Publish it again tomorrow" is the right advice, but "Director has published as many as it can" points at the wrong party. `rateLimitExceeded` is short-term, so "tomorrow" is pessimistic. All four were in the ruling, so I accept this. A `params`-driven variant of the message would make it exact.
  - `userRateLimitExceeded` still maps to UPSTREAM_UNAVAILABLE, which is fine.
  - The 429 isn't caught by any client-side "status 429 means RATE_LIMITED" mapping, because that mapping exists only for the auth forms (`packages/client/src/auth/errors.ts:24`).
- **Minor 1 (explicit `updated_at`): Addressed.** `publish.repository.ts:53-54`. The test of an hour-old cut published twice at once is at `publish.integration.test.ts:533`. The report's note that it also passes without the change is honest; the test pins the behaviour.
- **Minor 2 (credit read no longer a hard dependency of `copy`): Addressed.** `publish.service.ts:101-108` maps only UPSTREAM_UNAVAILABLE, which is what `ShortsService.cached` turns every `YouTubeError` into (`shorts.service.ts:79-86`). Test: `publish.integration.test.ts:620`.
- **Minor 3: Parked as ruled.** The comment sits at the claim (`publish.service.ts:181-184`).
- **Minor 4 (copy timeout): Addressed.** `COPY_TIMEOUT_SECONDS = 25` (`apps/ai/app/director.py:88-91`), and a test pins it against ai-client's 30 s default.
  - Caveat, a nit: pydantic-ai's `ModelSettings.timeout` limits each model request, not the whole run. An output-validation retry could still take the run past 30 s. That's unlikely with `PublishCopyDraft`'s plain `str` fields.
- **Minor 5 (fallback title cleaned): Addressed.** `apps/ai/app/publish_copy.py:72-73, 111`. For the edge case where both titles clean down to nothing, see the answer at the end.
- **Minor 6 (one byte limit on both sides): Addressed.** `fitsYouTube` (`packages/contracts/src/api/publish.ts:116-121`) is used by the upload input's refine and by the sheet's `draftSchema` (`publish-sheet.tsx:42-45`). The sheet's generic "invalid" alert then shows (`:142-143, 183-187`).
  - The Python mirror (`publish_copy.py:45, 76-84`) never under-counts. With empty credits it counts 1 byte more than TS, and with an empty description 2 bytes more. Both errors are on the safe side, and the fuzz confirms it.
  - `_within_bytes` decodes with `errors="ignore"`, so it never splits a character.
- **Minor 7 (no re-send on reopen): Addressed.** `PublishBody` keeps its own copy of the kept draft (`publish-sheet.tsx:276`), and `onResumed` clears it in the parent (`:301, 368`). On remount it starts from Director's post. The reopen is covered in the existing test (`publish-sheet.test.tsx:205-211`).
- **Minor 8 (sessionStorage guarded): Addressed.** `publish-sheet.tsx:53-71`, with two browser tests (`:214`, `:227`).
- **Minor 10 (nits): Addressed.** The doc comment in `apps/api/src/modules/shorts/youtube.ts:1-6` is re-wrapped, and the `MAX_TITLE`/`MAX_HASHTAGS` aliases are gone.

### New issues (Critical / Important / Minor)

#### Critical
None.

#### Important

1. **A place is given back even when the video, or the quota charge, did reach YouTube.**
   - Where: `publish.service.ts:140-146` together with `youtube-upload.ts:91-95`.
   - The `.catch` gives the place back on any upload error. That includes the PUT phase: the 10-minute abort, a dropped connection, a storage stream error mid-PUT (all `503 "unreachable"`), a 5xx from YouTube, and `uploadedVideo.parse` failing on a response YouTube sent after it created the video.
   - By then the session POST, which is the `videos.insert` call YouTube bills, has been accepted. In the timeout and parse cases the video may even exist.
   - The ruling was "given back if nothing reached YouTube". The cap exists to keep inserts within the project quota, where at the documented 1,600 units per insert, five use 8,000 of the default 10,000. One or two uncounted inserts in a day are enough to break indexing's reads, which is exactly what the cap is for.
   - A storage hiccup mid-stream also lets one member repeat this, bounded only by the 5-per-hour rate limit.
   - Fix: give the place back only when the session was never opened, meaning the error came from `start()`. For example, `YouTubeUploader` could tag the error with its phase, or the service could check it. Keep the place once the PUT has begun. Add an integration case where the mock fails the PUT and the count stays.

2. **The day is a UTC day, but YouTube's quota day starts at midnight Pacific time.** This is ruling-level, for the controller.
   - Where: `daily-allowance.ts:16-22`.
   - YouTube Data API quotas reset at midnight PT, which is 07:00 or 08:00 UTC. A UTC-day counter spans two quota days. Five publishes late in UTC day D and five early in UTC day D+1 can land in the same PT quota day: ten inserts, about 16,000 units against 10,000. That's the outage the cap was meant to prevent.
   - The implementer followed the ruling's "UTC day", so this is not their defect.
   - Fix (cheap): key and expire the counter on the America/Los_Angeles date, with `Intl.DateTimeFormat` for the date and the next PT midnight, DST aware. Then update the contract's comment ("until midnight UTC", `publish.ts:46-50`). Otherwise, halve the cap.

#### Minor

1. **A `claim` that throws leaks the day's place until midnight.**
   - Where: `publish.service.ts:185`.
   - `take()` has succeeded, and a DB error in `claim` propagates through `upload`'s catch (`:122-125`), which only cancels the stream.
   - With a cap of 5, one leak is 20% of the day.
   - Fix: wrap the claim, giving the place back on a throw as well as on `false`.

2. **`?publish=<id>` now opens the sheet for a cut that is already published or on its way.**
   - Where: `publish-sheet.tsx:354-356`.
   - Before the fix, the early return meant a published cut never opened a dialog. Now `open` starts as `returning`, whatever the status.
   - The query string is never removed, so reloading after a resumed publish succeeded (`/media?publish=<id>`) opens the sheet again. The kept draft has been consumed, so it asks Gemini for a new post, which spends the `director-publish` budget, for a cut that's already on YouTube.
   - Fix: start open only when `returning` and the status is `none` or `failed`, or drop the param once it's read.

3. **Focus is lost on close after a publish.**
   - The dialog has no `DialogTrigger`, so Radix returns focus to the element focused before it opened. That was the "Publish" button, which `Trigger` has since swapped for the WatchLink, so focus falls to `<body>`.
   - Fix: pass `onCloseAutoFocus` and move focus to the card's new trigger or link.

4. **A failing `giveBack` or `failed()` hides YouTube's error.**
   - Where: `publish.service.ts:142-145`.
   - `Promise.all` rejects with the Redis or DB error, so the member sees INTERNAL instead of, say, PUBLISH_QUOTA_EXHAUSTED or PUBLISH_NO_CHANNEL.
   - Fix: use `Promise.allSettled` and then throw `publishErrorOf(error)`.

5. **The DECR after a refused take is a separate command.**
   - Where: `daily-allowance.ts:44`.
   - Between a refused take's INCR and its DECR, the count reads one higher. A concurrent take can then be refused although a place was just given back.
   - The upper bound still holds, so this is harmless apart from a rare false refusal. A small Lua script (INCR, then DECR when over the cap, plus EXPIREAT) would make the whole take one atomic step.

6. **At the cap, a second click on a cut that's already uploading gets PUBLISH_QUOTA_EXHAUSTED instead of "already on its way".** The take runs before the claim, as ruled. This one is cosmetic.

7. **The browser tests' AI stand-in.**
   - Test-only: `apps/web/test/fake-ai.ts`, started from `global-setup.ts:76`, with `pg` already a dev dependency.
   - It's closed before the database is dropped (`fake-ai.ts:137-140`, `global-setup.ts:160-162`).
   - It connects as the `postgres` superuser, the same role as the existing `sql` command (`global-setup.ts:147`), so it bypasses RLS. That's acceptable for a fixture: it only overlays cuts it already scoped to the caller, by id. It does mean the fixture can't catch an RLS mistake; apps/ai's own tests cover that.
   - Nits:
     - A failed query in the async request handler is an unhandled rejection that leaves the request hanging.
     - `withPublishing` handles the single-cut case by recursing with casts. A small `overlay(rows, cut)` helper would read better. Casts are allowed under `test/`.

### The edge case the implementer raised (both titles clean down to nothing, and the AI answers 500)

It shouldn't be a validation error. The request, a valid `cutId` for the caller's own cut, isn't at fault, and VALIDATION_FAILED would blame the caller. It shouldn't be a 500 either. The outcome is deterministic, it comes from member input (`saveCut` lets `<>` or `#Shorts` through as a title, `packages/contracts/src/api/director.ts:379`), and it reaches the logs as an internal error after the tokens are already spent.

The cleanest fix is a third fallback in `tidy`: the plan's original title, cleaned. YouTube itself refuses angle brackets in titles. If that's empty too, raise `AppError("UPSTREAM_UNAVAILABLE", {"service": "gemini"})`. The sheet already answers that with its editable fallback, and its client check then asks the member for a valid title.

The deeper fix belongs to a later task: since "a cut's title becomes its YouTube title", `saveCut` should refuse angle brackets as `publishCopySchema` does. This is Minor and doesn't block.

### Assessment

**Needs fixes.** Most of the round is done well: the sheet now stays mounted, the quota reasons map to an honest 429, and every other ruled Minor is fixed with tests. But the daily cap gives its place back even after the insert has been billed or the video created, which goes against the ruling's "nothing reached YouTube". Its UTC day also doesn't line up with YouTube's Pacific-time quota day. Both fixes are small (give the place back only before the session opens; key the counter on the PT date) and should land before the cap is relied on. The controller should also confirm the move from a UTC day to a PT day.
