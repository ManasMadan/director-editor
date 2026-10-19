# Tasks 2.4.1 (remaining) + 2.4.2: Google sign-in test and publish to YouTube

Global constraints and Review Focus of the plan apply:
## Global Constraints

- Product name is **Director** everywhere user-facing; "Director-editor" never appears in UI, emails or page titles.
- Every user-facing string goes through `packages/i18n` (en only; drop `es`).
- Every loading/waiting state uses the shared Gemini-style loader (shimmer gradient + sparkle), never a plain spinner.
- Indexing model: `gemini-4-argon` (env `INDEX_MODEL`). Interactive model (scene checks, reviews, publish copy): `gemini-3.8-flash` (env `DIRECTOR_MODEL`). Live call model: env `LIVE_MODEL`, default `gemini-live-2.5-flash-native-audio` unless a newer Live model answers. TTS: `gemini-3.8-flash-tts`.
- Gemini YouTube input: `VideoUrl(..., media_type="video/*")` (Vertex returns 500 for `video/mp4`).
- One user-indexed Short per user (seeded copies don't count). Error code `DIRECTOR_INDEX_LIMIT`.
- Seeded templates: exactly 6, copied into each workspace at creation; `source = 'seed'`.
- Takes are never replaced; a shot needs a retake when its best take's score < `DIRECTOR_RETAKE_BELOW = 60`.
- Demo account: publishing disabled; can index one Short.
- Google auth uses the VM's service account (metadata server / ADC); no key files. Vertex express-mode API key stays only where already used.
- Hosts stay under `director.mmadan.in` (`files.`, `mail.`); no new proxied two-level hosts.
- Follow the repo rules (CLAUDE.md, `.claude/rules/*`): contracts-first, RLS via `tenant`/`withTenant`, expand/contract migrations, 100% coverage (or a listed exception in docs/testing.md), no casts/`any`.
- No hard-coding, fakes or stubs anywhere except tests (owner, 2026-10-18): the running app and `bun dev` use the real Google services (Gemini on Vertex, YouTube, Live, TTS, Cloud Storage); `packages/fake-google` and other fakes exist only as test fixtures; `.env.example` defaults point at real services (keys empty), never at a mock; no hard-coded user-facing text or canned results in app code.
- Commits: Conventional Commits with a workspace scope; the owner pushes with `--no-verify` (hooks are disabled locally); CI is the gate.

## Review Focus

1. A Short that is private, removed, age-restricted, longer than 3 minutes, or not a Short: indexing fails with a clear reason and does **not** consume the user's one index.
2. Indexing output with inconsistent timings (shots overlapping, script lines outside their shot, durations not summing): repaired, not failed.
3. Two quick index requests from the same user (double-click, two tabs): only one counts; the second gets `DIRECTOR_INDEX_LIMIT` or the same plan.
4. Live call when the mic/camera is denied, the socket drops, or the relay's token expires mid-call: the UI falls back to Director Live without losing the current shot or takes.
5. Publishing from the demo account, or a cut whose file is missing/not yet uploaded: refused with a friendly message; nothing reaches YouTube.

Each is pinned by a test in the owning task (marked **[RF n]**).

### Workstream 2.4: Google sign-in and YouTube publish (api + web)

**Interfaces — Produces:** `publish.copy` POST `/media/{cutId}/publish-copy` → `{title, description, hashtags: string[], credits: string}` (Gemini Flash via ai `/v1/director/publish-copy`); `publish.upload` POST `/media/{cutId}/publish` `{title, description, hashtags, visibility: "unlisted"|"private"|"public"}` → `DirectorCut` (publish status). Error codes `PUBLISH_DEMO_DISABLED`, `PUBLISH_NEEDS_YOUTUBE` (403, client starts consent), `PUBLISH_CUT_NOT_READY`.

#### Task 2.4.1: Google sign-in
- [ ] Owner creates OAuth client (lead gives steps: consent screen External + "In production", scopes `openid email profile`; web client with redirect `https://director.mmadan.in/api/auth/callback/google`; YouTube scope requested incrementally). Secrets `GOOGLE_CLIENT_ID/SECRET` into `api.sops.yaml`.
- [ ] Integration test (fake Google): Google sign-in creates a user with a personal workspace and 6 seeds.

#### Task 2.4.2: Publish
- [ ] Web: Publish sheet shows the video, editable title/description/hashtags/credits, visibility (default unlisted); if `PUBLISH_NEEDS_YOUTUBE`, calls better-auth `linkSocial({provider: "google", scopes: ["https://www.googleapis.com/auth/youtube.upload"]})` then retries.
- [ ] API: reads the cut from storage, resumable `videos.insert` (`part=snippet,status`, `snippet.title` gets ` #Shorts`, `description` ends with credits + original link, `status.privacyStatus`, `status.selfDeclaredMadeForKids=false`) with the user's Google access token (better-auth `getAccessToken`, refreshes). Records publish status; emits BigQuery event.
- [ ] Integration tests (fake YouTube): demo user → `PUBLISH_DEMO_DISABLED` **[RF 5]**; missing file → `PUBLISH_CUT_NOT_READY` **[RF 5]**; success stores `youtubeVideoId`.

## Controller rulings for this task

- `app_api` has only SELECT on `ai.director_cut` today. Publishing updates publish_status / youtube_video_id / visibility: add a migration granting app_api UPDATE on exactly those columns (column-level grant), expand-only, with an integration test that app_api can update them and nothing else.

- Record `published` through AnalyticsService (apps/api/src/modules/analytics, merged by 2.6.2) when the upload succeeds, if that module is merged when you start; otherwise leave a clearly named call site for the controller to wire.
