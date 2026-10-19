# Task 2.4 review 1 (71d4f57..29febf9)

### Spec Compliance
- ✅ 2.4.1 integration test: Google sign-in through the fake Google OAuth creates a user with a personal workspace and 6 seeds — `apps/api/test/publish.integration.test.ts:300`
- ✅ `publish.copy` POST `/media/{cutId}/publish-copy` → `{title, description, hashtags, credits}`, Gemini (DIRECTOR_MODEL) via ai `/v1/director/publish-copy`, budgeted as `director-publish` — `packages/contracts/src/api/publish.ts`, `apps/ai/app/director.py` (`publish_copy`), `apps/ai/app/main.py`
- ✅ `publish.upload` POST `/media/{cutId}/publish` → `DirectorCut`, visibility defaults to `unlisted` — `packages/contracts/src/api/publish.ts`. One deviation: `credits` is also a required input field. It makes sense because the sheet edits it, but the brief's interface didn't list it.
- ✅ Error codes `PUBLISH_DEMO_DISABLED` (403), `PUBLISH_NEEDS_YOUTUBE` (403), `PUBLISH_CUT_NOT_READY` (409), all translated. `PUBLISH_NO_CHANNEL` and `DIRECTOR_CUT_NOT_FOUND` are extra — `packages/contracts/src/errors.ts`, `packages/i18n/messages/en.json`
- ✅ The resumable `videos.insert` sends `part=snippet,status`, a title with ` #Shorts`, a description ending with the credits and the original link, `privacyStatus` and `selfDeclaredMadeForKids=false`. It streams from storage and uses the member's token from `getAccessToken` — `apps/api/src/modules/publish/youtube-upload.ts`, `publish.service.ts:95-147`
- ✅ It records the publish status and emits `published` through AnalyticsService — `publish.service.ts:136-146`
- ✅ [RF 5] The demo account gets `PUBLISH_DEMO_DISABLED` and nothing is uploaded (`publish.integration.test.ts:320`). A missing or unchecked file gets `PUBLISH_CUT_NOT_READY` and nothing is uploaded (`:335`). A successful publish stores `youtubeVideoId` (`:368`).
- ✅ The web publish sheet shows the video, editable title/description/hashtags/credits and the visibility (unlisted by default). On `PUBLISH_NEEDS_YOUTUBE` it calls `linkSocial` with `youtube.upload` and retries once — `apps/web/src/modules/director/components/publish-sheet.tsx`
- ✅ Controller ruling, column-level grant, expand-only, with a test that app_api may update those columns only and only in its own workspace — `packages/db/prisma/migrations/20261018190000_director_cut_publish/migration.sql`, `packages/db/test/security.test.ts`. Deviation: the grant also covers `updated_at`. The ruling said "exactly those columns", but Prisma writes `updated_at` and the stale-upload takeover needs it. Justified; the controller should sign it off.
- ⚠️ Cannot verify from the diff: the owner's OAuth client setup (consent screen, redirect URI, `youtube.upload` scope on the consent screen, YouTube Data API enabled) and the SOPS secrets.

### Strengths
- The checks run in the right order: demo, feature, ownership through the AI service under RLS plus `user_id`, the file through `FilesService.readUrl` (the caller's own, checked), scope, token, then claim. Nothing reaches YouTube before every refusal has had its chance. Each refusal is pinned by an integration test against the real API, real Postgres and storage, and the fake Google.
- OAuth tokens are encrypted at rest (`encryptOAuthTokens: true` already in `auth.ts:170`). The access token goes only into the `Authorization` header. It is never returned or logged: `YouTubeUploadError` carries only status and reason, and 403s aren't logged.
- The video is streamed from storage to YouTube with a Content-Length (`duplex: "half"`), never buffered. Its stream is cancelled on every early exit, and the PUT has a 10-minute abort, which stays under the 15-minute stale window.
- The claim is a conditional `updateMany` under `withTenant`, which handles a double click or two tabs, and a stale `uploading` can be taken over. Both are tested.
- The upload URL is derived from the validated `YOUTUBE_API_URL`, with no user input in any outbound URL, so there is no SSRF surface. The session URL comes from Google's `Location`.
- The fake Google (OAuth with an RS256 ID token, JWKS, incremental scopes, refresh, resumable upload with the scope, no-channel and audit behaviour) is thorough and test-only. It lets better-auth's real Google provider run end to end.
- The privacy YouTube actually returns is what gets recorded, not what was asked, and it is said honestly in the UI copy.
- Every string goes through i18n, and the Gemini loaders and shimmer are used.

### Issues

#### Critical (Must Fix)
None.

#### Important (Should Fix)

1. **In the real My media page, the sheet's success and "already on its way" states vanish almost at once.**
   - Where: `apps/web/src/modules/director/components/publish-sheet.tsx:314-320` together with `packages/client/src/api/publish/upload.ts:15`.
   - What's wrong: `usePublishMutation` invalidates `director.media` when it settles. `CutCard` then re-renders `PublishButton` with the refetched cut, now `published` (or `uploading`). The early returns (`WatchLink` / `null`) unmount the `Dialog`, and `PublishBody` with it. "It's on YouTube, private…", the "You asked for public, but YouTube keeps… private" note and "This video is already on its way" are all deliberate features, and each one disappears as soon as the refetch lands.
   - Why tests miss it: `publish-sheet.test.tsx` renders `<PublishButton cut={…}>` with a static prop and a fake AI cut that never changes state, so it never sees this.
   - Fix: while the dialog is open, keep it mounted whatever `cut.publish.status` says. For example, apply the status branches only to the trigger and always render the `Dialog` while `open`. Add a browser test that publishes from the real My media page, where the AI stand-in's media list reflects the new status, and asserts the success text stays visible.

2. **The project's YouTube quota has no protection, and running out of it surfaces as a generic outage.**
   - Where: `apps/api/src/modules/publish/publish.service.ts:54-66`, the contract's `rateLimit` of 5 per hour per user.
   - What's wrong: `videos.insert` costs a large share of the default 10,000 units a day (the report's own concern 2). That quota is very likely the same project quota that indexing's `videos.list` reads use, if the API key and OAuth client are in one project. A handful of publishes a day can therefore break indexing for everyone. When it happens, `quotaExceeded` and `uploadLimitExceeded` become `UPSTREAM_UNAVAILABLE` ("YouTube unavailable") and the cut is marked failed. `copy` also fails whenever the `credit` read fails (item 2 under Minor).
   - Fix: either a project-wide daily publish cap (a Redis counter sized to the quota, refused before the claim), or at minimum a distinct, honest message for quota exhaustion. Otherwise the controller should record this explicitly as an accepted risk, with a quota increase requested.

#### Minor (Nice to Have)

1. **The claim depends on Prisma bumping `updated_at` without saying so.**
   - Where: `apps/api/src/modules/publish/publish.repository.ts:53`.
   - What's wrong: `claim` writes only `publishStatus: "uploading"` and relies on `@updatedAt` refreshing `updated_at` inside `updateMany`. If it doesn't, the common case breaks: a cut saved more than 15 minutes ago and double-clicked would pass the stale-takeover branch twice and upload twice. The concurrency test (`publish.integration.test.ts:433`) uses a cut created just now, so it can't catch this.
   - Fix: set `updatedAt: new Date()` explicitly (the grant already allows it) and add the concurrent-publish case for a cut whose `updated_at` is an hour old.

2. **The YouTube credit read is a hard dependency of `copy`.**
   - Where: `publish.service.ts:88`.
   - What's wrong: when YouTube's read fails (quota, outage), `copy` fails with UPSTREAM even though Gemini could write the post without the original.
   - Fix: map a `YouTubeError`/UPSTREAM there to `original: null`.

3. **A publish YouTube accepted can be uploaded again.**
   - Where: `publish.service.ts:128-136`.
   - What's wrong: if `publishing.published(...)` throws after YouTube has accepted the video (a DB hiccup), or the process dies between the two, the cut stays `uploading`. A retry after 15 minutes uploads a duplicate to the member's channel.
   - Fix: at least log the YouTube id before writing, so it can be recovered, or retry the DB write. Otherwise note it as accepted.

4. **The two copy timeouts are the same.**
   - Where: `apps/ai/app/director.py:89` and `packages/ai-client/src/index.ts:171`.
   - What's wrong: `COPY_TIMEOUT_SECONDS = 30` equals the AI client's 30 s default. A slow Gemini answer is cut off by the API first, while the AI service still spends and settles the tokens.
   - Fix: make the model timeout a few seconds under the client's, or give this call a longer client timeout.

5. **The fallback title isn't cleaned.**
   - Where: `apps/ai/app/publish_copy.py:84`.
   - What's wrong: `fallback_title` (the cut's own title) isn't stripped of `<`/`>`. When Gemini's title tidies down to nothing and the cut's title has an angle bracket, the API's `publishCopySchema.parse` (`publish.service.ts:92`) throws a ZodError, which becomes a 500.
   - Fix: run the fallback through `_without_brackets` too.

6. **A long non-Latin draft fails only on the server.**
   - Where: `publish_copy.py:85` and `packages/contracts/src/api/publish.ts:154`.
   - What's wrong: `tidy` limits the description to 3,000 characters, but the upload refines on 5,000 UTF-8 bytes. A long Hindi or Japanese draft passes `copy` and the sheet's client-side `draftSchema`, which has no byte check, then fails upload with a generic VALIDATION_FAILED. Unlikely given the "two or three sentences" instruction.
   - Fix: apply the byte refine in `draftSchema` as well, so the inline "invalid" message shows.

7. **Reopening the dialog after a failed resumed publish sends it again.**
   - Where: `publish-sheet.tsx:273-278`.
   - What's wrong: `PublishBody` unmounts when the dialog closes, so its `sentAgain` ref resets. Reopening the dialog after a resumed publish failed (say, `PUBLISH_NO_CHANNEL`) re-sends the kept draft without a click.
   - Fix: clear `resumed` in `PublishButton` once it has been sent.

8. **sessionStorage use isn't guarded.**
   - Where: `publish-sheet.tsx:53-57`.
   - What's wrong: `sessionStorage` access and `JSON.parse` aren't in try/catch. Blocked storage or a corrupted value would throw during render.

9. **Some members can never grant the upload scope.**
   - What's wrong: a password-only member whose Google account has a different email can't link it, because `accountLinking` has no `allowDifferentEmails`. After the round trip they see `PUBLISH_NEEDS_YOUTUBE` again with no hint why. This is a product limitation more than a bug.
   - Fix: consider a clearer message, or decide on allowing different emails.

10. **Nits.**
    - The doc comment at `apps/api/src/modules/shorts/youtube.ts:3` now runs past the wrap width.
    - The `MAX_TITLE`/`MAX_HASHTAGS` aliases in `publish_copy.py` exist only for the tests; they could import the `MAX_PUBLISH_*` constants directly.

### Assessment
**Task quality:** Needs fixes
**Reasoning:** The server side is solid and meets the brief: authorization order, token handling, streaming, idempotent claim, column-level grant and the RF 5 tests. But in the real My media page the sheet's success and "already on its way" states unmount as soon as the list refetches, and the tests miss this because they render the button with a static cut. The quota exposure needs a guard or an explicit sign-off as an accepted risk.
