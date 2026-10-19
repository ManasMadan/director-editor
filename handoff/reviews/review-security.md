I didn't write `/private/tmp/.../scratchpad/review-security.md`. My instructions don't allow me to edit files or write report files, so the findings are below in full instead. The only thing I created is a read-only copy of `origin/master` at `/private/tmp/claude-503/-Users-manas-madan-Desktop-code-director-editor/f1ddf0d8-5838-46aa-97e0-9a9cb55506ef/scratchpad/tree/`, extracted with `git archive` so I could read it. You can delete it.

**Counts:** critical 0, high 1, medium 1, low 1.

**Top 3:**
1. **High:** Director's slower line (`director.chat`) calls Gemini without counting against any AI allowance.
2. **Medium:** on the shared demo account, one visitor sees what the previous one uploaded and typed, and none of it is ever deleted.
3. **Low:** several kinds of stored objects are never deleted when their rows go.

## Findings

**[high] `apps/api/src/modules/live/live.chat.ts:228-232`, `apps/api/src/modules/director/director.service.ts:218-223`, `packages/contracts/src/api/director-chat.ts:128-130`: `director.chat` spends paid Gemini calls without counting them anywhere**
- **Problem:** the API calls Vertex directly with the machine's service account. The call never goes through the AI service's usage ledger, so neither the workspace's monthly allowance (`AI_MONTHLY_TOKENS_PER_ORG`) nor a guest's smaller one (`AI_MONTHLY_TOKENS_PER_DEMO_GUEST`) applies. Each call can be two generate requests (one with a camera frame), and the system instruction includes the whole persona and plan.
- **Only limit:** 30 calls a minute per user, with nothing lower for guests. Live, by comparison, gets a separate, smaller hourly limit for guests.
- **How it's abused:** sign up, or take a demo guest (one captcha, if Turnstile is on in production, buys 24 hours). Then script `POST /director/{videoId}/chat` with `turn: {kind:"said"}` and a frame, 30 times a minute. That is about 1,800 Gemini calls an hour per account, around the clock, none of them counted. With up to `DEMO_GUEST_LIMIT` = 50 guests at once, that's roughly 90,000 calls an hour against the project's $300 credits.
- **Fix:**
  - Reserve and settle each turn through the AI service's ledger, like `locate`, `editor` and `revise` do (or have the API write `ai.usage` under the same allowance).
  - Lower the limit to what a person can say (about 10 a minute, plus an hourly cap).
  - Give guests their own, smaller limit, as `director-guest-calls` does for Live.

**[medium] `apps/api/src/modules/recording/recording.service.ts:123`, `apps/api/src/modules/assets/assets.service.ts:139,171`, `apps/api/src/modules/director/director.service.ts:390,402`, `packages/contracts/src/api/your-version.ts:136`, `apps/ai/app/picker.py:113`, `packages/db/prisma/migrations/20261018200000_demo_guests/migration.sql:110`: shared demo visitors see each other's personal data, and it's kept forever**
- **Problem:** only `recording.start` is refused for `sharedDemo`, because "everyone on it would see everyone's footage". Every other new per-member write is still allowed on the shared account, and everyone signed in to it is the same user:
  - asset uploads, drawn images with their prompts, and stock picks (`assets.addUpload` / `draw` / `addStock`); the picker lists rows where `user_id == caller`;
  - created templates with their brief text (`director.brainstorm` / `create`);
  - the memory notes Director keeps of what the member said (`yourVersion.save` / `revise`, and Live's `remember`).
- **Retention:** `files.purge_demo_footage` only removes the `director-take-video`, `director-take-photo` and `director-cut-video` purposes. Nothing purges `director-brief-photo`, `director-asset-image`, `ai.director_asset`, created plans or `app.director_version` for the shared user.
- **How it's exploited:** the sign-in page prints the shared account's email and password (`system.info`, `demo-account.tsx:191-205`), and visitors are also sent there when guests are full. Sign in and open a template's asset picker: you get signed links to the previous visitors' uploaded pictures, their prompts, the brief text in the library's created templates, and Director's notes about them.
- **Fix:** refuse these writes with `DEMO_ACCOUNT_LOCKED` when `context.sharedDemo` is set, the same way `recording.start` does. Or purge them daily for the shared user: extend `purge_demo_footage` to the two new purposes, and delete the non-default `director_asset` rows, created plans and `director_version` rows.

**[low] Stored objects that are never deleted, against the "nothing outlives the day" and account-deletion promises**
- **What's left behind:**
  1. `ai.director_asset` has no delete trigger feeding `files.object_deletion`. When a guest is purged, an account is deleted or a plan goes, every `director-assets/<plan>/...` object stays in the bucket: drawn images (including image-to-image of the member's own photo), stock copies, Veo clips and storyboards.
  2. The post-session pass composes `recordings/<session>/<part>/whole` (`apps/ai/app/session_recordings.py:290`) and removes it only in the `finally` at `session_pass.py:330`. If the worker is killed or redeployed mid-pass, or a compose fails after its first round, the joined copy of the whole raw footage is orphaned.
  3. A slice upload URL stays valid for 10 minutes (`recording.service.ts:216`). A client can sign slices, delete the session, wait for the files cleanup at :20 or :30, then PUT up to 8 MB per URL to keys nobody will delete again. That's up to about 4.8 GB an hour per account at 600 signs an hour.
- **Impact:** no read path. The keys are unguessable and nothing signs them once their rows are gone. The cost is retention and storage.
- **Fix:**
  - Add an `AFTER DELETE` trigger on `ai.director_asset` that queues `object_key` (and `reference_key` when it's under `director-assets/`).
  - Insert the `whole` keys into `files.object_deletion` before composing.
  - Add bucket lifecycle rules on `recordings/` (older than 15 days) and `director-assets/` as a backstop.

## Verified clean
- **Authorization:** every new procedure is `inOrg` (recording, assets, editor, yourVersion, and director's new locate, chat, chooseTake, alignMatchCut, brainstorm, create and editPlan). Ids come from context. Recording queries go through `withTenant`/`tenantTx` and name the member. The AI side checks ownership: `_slot_image`, `choose`, `edit` (`created_by`), and takes per user. `files.ready`/`readUrl` check the owner for the reference, brief and cut files.
- **Migrations:** every new tenant table has ENABLE and FORCE row-level security with `tenant_isolation`. The `SECURITY DEFINER` functions set `search_path` and have EXECUTE revoked from PUBLIC. `app_ai` gets read access plus a column-limited INSERT on attempts (no `file_id`). `app_worker`'s new INSERT is column-limited. The new `USAGE ON SCHEMA app` exposes no executable functions, because the older app functions are already revoked.
- **Demo guests:** each gets its own user and workspace, with no recording on the shared account. Sessions are clamped to `guestUntil` and their Valkey keys removed on purge. Places are counted atomically, limited per IP, and captcha applies when configured.
- **Input validation:** contracts have bounds on every new input. Queue payloads go through `parseJob`. Python request models are constrained. The asset id regex keeps storage keys inside the plan's folder.
- **SSRF:**
  - Stock copies refetch the photo by its numeric id and download only from an allow-list of provider hosts. They don't use `safeFetch` and they follow redirects, but the URL comes from the provider, never the client.
  - The clipper and aligner only receive presigned URLs from the API or worker. On Cloud Run they check an ID token for the right audience and invoker.
  - ffmpeg runs with the demuxer forced, `-protocol_whitelist`, and no secrets in its environment (`jail.py`). Production requires an HTTPS `CLIPPER_URL`.
- **Uploads:** the new purposes go through the scan pipeline and are re-encoded by `sharp`. Slices are presigned for exact size and type, the first slice's signature is checked, and the clipper re-encodes the take.
- **Live WebSocket:** checks Origin against `WEB_URL`, uses the same session and membership check as `inOrg`, allows one call per user per process, and charges the hourly limit before starting. Client messages are schema-checked and budgeted (audio, turns, moves, notes).
- **Prompt injection:** tool calls from Live, chat, the editor and the session pass are checked against the plan and only change the caller's own version, takes and marks. Editor edits are applied in the browser.
- **Secrets and logs:** new env vars are in `env.ts` and `.env.example` with empty or dev values. Production refuses non-HTTPS/WSS `LIVE_API_URL`, `CHAT_API_URL`, `PEXELS_API_URL`, `PIXABAY_API_URL` and `CLIPPER_URL`/`ALIGNER_URL`, and refuses `GOOGLE_ACCESS_TOKEN`. Activity and analytics only record ids, counts and scores, with no transcripts, prompts or URLs.
- **SQL:** only tagged `$queryRaw` and bound `text()` parameters. The one `$queryRawUnsafe` (maintenance) predates this.
- **CSP:** tightened; jsDelivr, Google storage and `wasm-unsafe-eval` were removed.

## Smaller notes (no way to exploit found)
- `director.service.ts:493-502` (`withStoryboards`) signs whatever storyboard key the AI service returns, without the prefix check that `imageKeyAllowed`/`planAssetImages` apply elsewhere.
- Stock copies (`stock.ts:148`) are stored without the virus scan or `sharp` re-encode.

## Not verified
- Production settings: whether `TURNSTILE_*` is set (without it, a bot can take all 50 guest places for 24 hours), whether `DEMO_PASSWORD` is set, and whether the bucket has lifecycle rules. The GCP deploy config isn't in `infra/` here.
- Cloud Run IAM for the clipper and aligner.
- Web components and `packages/fake-google` were only skimmed.
- No tests or services were run; this was a read-only review.

**blockers found**