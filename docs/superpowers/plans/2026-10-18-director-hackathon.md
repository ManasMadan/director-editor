# Director hackathon build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the starter-kit repo into "Director": a polished, Google-Cloud-native app where users shoot their own version of any YouTube Short with Gemini as a live video-call director, then publish it to YouTube.

**Architecture:** Keep the monorepo (Next.js web, NestJS api, Python FastAPI ai + worker, Postgres with RLS, k3s + Argo CD on one GCE VM). Strip the starter's non-Director features, reshape Director's data around templates -> takes -> cuts, move indexing's Gemini work to a private Cloud Run service, media to Cloud Storage, and add a Gemini Live relay in the api for the call.

**Tech Stack:** TypeScript (NestJS, oRPC, Next.js, Prisma), Python 3.14 (FastAPI, Pydantic AI, BullMQ), Postgres, Valkey; Google: Vertex AI (Gemini 4 Argon, Gemini 3.8 Flash, Gemini Live native audio, Gemini 3.8 Flash TTS, Veo 3.1, Lyria, Nano Banana 2.1), Cloud Run, Cloud Storage, Artifact Registry, BigQuery, YouTube Data API.

**Spec:** `docs/superpowers/specs/2026-10-17-director-hackathon-design.md` (read it first; this plan argues from it).

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
- Commits: Conventional Commits with a workspace scope; the owner pushes with `--no-verify` (hooks are disabled locally); CI is the gate.

## Review Focus

1. A Short that is private, removed, age-restricted, longer than 3 minutes, or not a Short: indexing fails with a clear reason and does **not** consume the user's one index.
2. Indexing output with inconsistent timings (shots overlapping, script lines outside their shot, durations not summing): repaired, not failed.
3. Two quick index requests from the same user (double-click, two tabs): only one counts; the second gets `DIRECTOR_INDEX_LIMIT` or the same plan.
4. Live call when the mic/camera is denied, the socket drops, or the relay's token expires mid-call: the UI falls back to Director Live without losing the current shot or takes.
5. Publishing from the demo account, or a cut whose file is missing/not yet uploaded: refused with a friendly message; nothing reaches YouTube.

Each is pinned by a test in the owning task (marked **[RF n]**).

---

## Phase 0 — Google Cloud groundwork (lead runs these directly; no repo changes)

### Task 0.1: VM identity, bucket, registry, APIs

- [ ] Enable APIs: `run`, `artifactregistry`, `iamcredentials`, `texttospeech`, `bigquery`, `youtube` (already), `aiplatform` (already).
- [ ] Create SA `director-vm@…`; roles: `aiplatform.user`, `run.invoker`, `bigquery.dataEditor`, `bigquery.jobUser`; `iam.serviceAccountTokenCreator` on itself; `storage.objectAdmin` on bucket `director-media-1053522546520` (create it, us-central1, uniform access, public access prevention, CORS: origin `https://director.mmadan.in`, methods GET/PUT/HEAD, header `content-type`).
- [ ] Stop VM, set SA `director-vm` with scope `cloud-platform`, start VM (~5 min downtime, approved). Verify from a pod: `curl -H 'Metadata-Flavor: Google' http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/email`.
- [ ] Artifact Registry repo `director` (docker, us-central1). Cloud Run SA `director-indexer@…` with `aiplatform.user`, `storage.objectAdmin` on the bucket.
- [ ] BigQuery dataset `director` (US) with table `events(time TIMESTAMP, kind STRING, user_id STRING, template_id STRING, video_id STRING, score INT64, detail JSON)`.
- [ ] Network policy: allow egress to `169.254.169.254/32:80` for api, ai, ai-worker pods only (chart change lands in Task 5.1).

**Verify:** `gcloud run services list`, `bq show director.events`, metadata email from an ai pod equals `director-vm@…`.

### Task 0.2: Pick the 6 seed Shorts and fetch their audio

- [ ] Using `YOUTUBE_API_KEY`, pick 6 public, embeddable Shorts ≤ 60 s, one each: talking head, product, recipe, multi-location travel, text-heavy, music/dance. Record id, title, channel, duration in `apps/ai/app/seeds/seeds.json` as `[{videoId, title, channel, kind}]`.
- [ ] On the owner's Mac: `yt-dlp -x --audio-format m4a -o '%(id)s.%(ext)s' <url>` for each; upload to `gs://director-media-…/seed-audio/<videoId>.m4a`.

---

## Phase 1 — Removal and rebrand (one worker, before Phase 2)

Use `.claude/skills/remove-feature/SKILL.md` as the procedure for each feature. Keep: auth (email+password, email OTP, Google), personal workspaces (hidden), files/uploads, notifications' email channel, the ai service + ai-client + token accounting, Director, Shorts (reshaped in 2.2), the webhooks app's Stalwart route.

### Task 1.1: Remove starter features

**Files:** per remove-feature's table for: todos + dashboard, documents assistant/RAG/sentiment (Python modules `assistant, documents, embeddings, chunking, summaries, mcp_server` and their routes/queue `ai-ingest`/tables), MCP + OAuth-provider plugins (`mcp`, `jwt`, `cimd`, connected apps, consent page), billing/Stripe/entitlements (`packages/fake-stripe`, webhooks' stripe route, `billing.prisma`, `stripe.yml`), API keys, outbound webhooks, SMS, push, in-app notifications inbox/preferences/digest, audit UI (keep the pipeline), `apps/mobile` + `mobile.yml`, `load/`, `es` locale.
- [ ] Post-sign-in default path becomes `/library` (`auth/hooks/use-next-path.ts`, `proxy.ts`, `user-menu.tsx`, `site-header.tsx`).
- [ ] Auth `billing.entitlements()` callers get a fixed single-member rule.
- [ ] Migrations: contract-phase drops for removed tables in one migration `remove_starter_features` (expand/contract: code stops using them in the same PR; acceptable since production has no data in them).
- [ ] `bun run gen`; regenerate openapi + ai-client; update docs/README/CLAUDE.md tables; commit with `!` (breaking API).

**Verify:** `bun run lint`, `bun run check-types`, `bun run test`, `bun run test:integration`, `bun run charts:check` all pass; `rg -i "todo|stripe|apikey|mcp" apps packages --type ts -l` returns only intentional matches.

### Task 1.2: Rebrand and hide workspaces

- [ ] `common.appName` = "Director"; better-auth `appName`, 2FA issuer, passkey `rpName` = "Director"; page titles, email sender name "Director".
- [ ] Remove from UI: workspace switcher, members, invitations, workspace settings (routes 404). Keep the personal workspace creation.
- [ ] Test: `apps/web` e2e smoke asserts no "Director-editor" text on `/`, `/sign-in`, `/library`.

---

## Phase 2 — Parallel workstreams (each in its own worktree; 2.2 merges first, its contract is the shared interface)

### Workstream 2.1: Indexing (apps/ai) and the Cloud Run indexer

**Interfaces — Produces:**
- `POST /v1/index` on a new ASGI app `app.indexer:app` (Cloud Run): body `{videoId: str, orgId: UUID, planId: UUID}`; returns `IndexResult {plan: ShotPlan, model: str, audio: {status: "ready"|"failed", objectKey: str|None}}`. Auth: Google ID token, audience = service URL (Cloud Run `--no-allow-unauthenticated`).
- Env (ai): `INDEX_MODEL`, `INDEXER_URL` (empty → index in-process), `MEDIA_BUCKET`.
- Worker publishes realtime `director.changed` with `stage`: `queued | watching | writing | ready | failed`.

#### Task 2.1.1: Prompt and schema for any Short
**Files:** `apps/ai/app/director.py` (PLAN_INSTRUCTIONS, `_planner`), `apps/ai/app/schemas.py`, `apps/ai/tests/test_director.py`.
- [ ] Extend `PLAN_INSTRUCTIONS` for: no person (pose empty, framing = object), no speech (script from on-screen text when it carries the story), on-screen text/doodles (carry as script lines + steps), fast cuts (merge cuts < 0.5 s), slideshows (photo shots), > MAX_SHOTS cuts (merge adjacent), and `purpose` = the scene's role (hook/setup/reveal/payoff) and intended feeling.
- [ ] `ShotPlan` gains `sceneRoles` nowhere new — keep the schema; only `Shot.purpose` description tightened. (No contract change.)
- [ ] Planner uses `INDEX_MODEL`; `VideoUrl` with `vendor_metadata`/`video_metadata` fps=3, media resolution medium (pydantic-ai `GoogleModelSettings`).
- [ ] Tests with the fake Google (canned plans) for: no-person plan accepted, no-speech plan accepted.

#### Task 2.1.2: Repair instead of fail
**Files:** create `apps/ai/app/plan_repair.py`; test `apps/ai/tests/test_plan_repair.py`.
- [ ] `def repair_plan(plan: ShotPlan, video_seconds: float | None) -> ShotPlan` — sorts shots by `sourceStartSeconds`, clamps source ranges into `[0, video_seconds]`, removes overlaps (end = next start), drops shots < 0.3 s, clamps `durationSeconds` to `[0.5, MAX_SHOT_SECONDS]`, clamps script lines into `[0, durationSeconds]` and drops empty ones, clamps steps' `atSeconds`, recomputes `ShotPlan.durationSeconds` as the sum. **[RF 2]**
- [ ] Tests: `test_repair_sorts_and_removes_overlaps`, `test_repair_clamps_script_into_shot`, `test_repair_keeps_a_valid_plan_unchanged`, `test_repair_drops_slivers_but_keeps_one_shot`.
- [ ] `analyze` calls `repair_plan` before saving.

#### Task 2.1.3: Indexing stages and failure reasons
**Files:** `apps/ai/app/director.py`, `apps/ai/app/worker.py`, tests.
- [ ] Publish stage at queue (`queued`), before the Gemini call (`watching`), after the response (`writing`), on save (`ready`), on failure (`failed` + error code).
- [ ] Refusals for private/removed/age-restricted/not-found map to `DIRECTOR_VIDEO_UNAVAILABLE`; too long → `DIRECTOR_TOO_LONG` (existing filmable check). A failed user index **does not count** toward the limit (2.2 counts only non-failed). **[RF 1]**

#### Task 2.1.4: Audio capture
**Files:** create `apps/ai/app/audio.py`; `apps/ai/Dockerfile` (deploy/docker/ai.Dockerfile) adds `yt-dlp` (pinned, with renovate comment) and `ffmpeg`.
- [ ] `async def fetch_audio(video_id: str, bucket: str) -> str | None` — `yt-dlp -x --audio-format m4a` to a temp dir, uploads to `gs://{bucket}/audio/{video_id}.m4a` (ADC), returns object key, or `None` on any failure (logged, not raised).
- [ ] Test with a fake runner: success returns key; non-zero exit returns `None`.

#### Task 2.1.5: Cloud Run indexer
**Files:** create `apps/ai/app/indexer.py` (FastAPI `app` with `POST /v1/index` and `/health/live`), `apps/ai/app/google_auth.py` (`async def id_token(audience: str) -> str` from the metadata server; `async def access_token() -> str`), worker change in `apps/ai/app/director.py` `analyze`: if `INDEXER_URL` set, POST there with the ID token; else run the same function in-process.
- [ ] Shared `async def index_short(video_id) -> IndexResult` used by both paths.
- [ ] Tests: in-process path writes the plan; remote path sends `Authorization: Bearer <token>` and saves the returned plan (fake HTTP server).
- [ ] Deploy (lead): mirror the `ai` image `sha-<commit>` from GHCR to Artifact Registry (`gcloud artifacts docker images copy` or `crane copy`), then `gcloud run deploy director-indexer --image … --command uvicorn --args app.indexer:app,--host,0.0.0.0,--port,8080 --service-account director-indexer@… --no-allow-unauthenticated --region us-central1 --timeout 900 --memory 2Gi --set-env-vars INDEX_MODEL=gemini-4-argon,MEDIA_BUCKET=…,GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=…,GOOGLE_CLOUD_LOCATION=global`; grant `director-vm` `run.invoker`. Add the command to `docs/deploy.md`.

#### Task 2.1.6: Evaluation over 12 Shorts
**Files:** create `apps/ai/evals/index_shorts.py` (runs against real Vertex with `--live`), `apps/ai/evals/shorts.json` (6 seeds + 6 hard cases).
- [ ] Prints per Short: shots, has-script, has-pose, repaired fields, pass/fail on "every shot has scene, framing, phoneAngle, ≥1 step".
- [ ] Bar: 12/12 index and pass. Lead runs it after deploy; failures feed back into 2.1.1.

### Workstream 2.2: Data model and API (contracts, db, api, ai service storage) — merges first

**Interfaces — Produces (contracts in `packages/contracts/src/api/director.ts`):**
- `directorPlanSchema` adds `source: "seed" | "user"`, `stage: "queued"|"watching"|"writing"|"ready"|"failed"`, `audio: {status: "ready"|"failed"|"none", url: string | null}`.
- `director.library` GET `/director/library` → `{templates: DirectorPlan[], indexUsed: boolean}`.
- `director.index` POST `/director/library` `{url: string}` → `DirectorPlan` (replaces `requestPlan`; throws `DIRECTOR_INDEX_LIMIT` (409), `DIRECTOR_VIDEO_UNAVAILABLE`, `DIRECTOR_TOO_LONG`).
- `directorTakeSchema` unchanged plus `needsRetake` is computed per shot in `director.shots`: GET `/director/{videoId}/shots` → `[{index, takes: DirectorTake[], pickedTakeId: string|null, needsRetake: boolean}]` (pick = highest score, ties → newest).
- `director.cuts` GET `/director/{videoId}/cuts`; `director.saveCut` POST `/director/{videoId}/cuts` `{picks: Record<number, string>, fileId: string, title: string}` → `DirectorCut`; `director.media` GET `/media` → `DirectorCut[]` grouped client-side by template.
- `DirectorCut {id, planId, videoId, templateTitle, title, picks, fileId, durationMs, createdAt, publish: {status: "none"|"uploading"|"published"|"failed", youtubeVideoId: string|null, visibility: string|null}}`.
- New file purpose `director-cut-video` (≤ 200 MB, mp4/webm).
- `DIRECTOR_RETAKE_BELOW = 60` exported from contracts.

#### Task 2.2.1: Schema and migration
**Files:** `packages/db/prisma/schema/ai.prisma`, new migration `director_library`, `apps/ai/app/db/models.py`, `apps/ai/tests/test_models_match_db.py`.
- [ ] `DirectorPlan` + `source text not null default 'user' check (source in ('seed','user'))`, `stage text not null default 'queued'`, `audio_status text not null default 'none'`, `audio_key text null`.
- [ ] New `DirectorCut` table `ai.director_cut` (id uuidv7, org_id, plan_id, user_id, title, picks jsonb, file_id → files.file, duration_ms int, publish_status text default 'none', youtube_video_id text null, visibility text null, created_at, updated_at), RLS `tenant_isolation`, grants to `app_ai` and `app_api` (select) per the director migration's pattern.
- [ ] Partial unique index for the limit: `create unique index director_plan_one_user_index on ai.director_plan (created_by) where source = 'user' and status <> 'failed';` **[RF 3]**

#### Task 2.2.2: Seeds copied at workspace creation
**Files:** `apps/ai/app/seeds/seeds.json` (Task 0.2), generated `apps/ai/app/seeds/templates.json` (Task 2.2.5), `apps/api/src/auth/auth-hooks.ts` (after org create), new `apps/api/src/modules/director/seeds.ts`.
- [ ] `async function copySeedTemplates(tx, orgId: OrgId): Promise<void>` inserts 6 `director_plan` rows (`source='seed'`, `status='ready'`, `stage='ready'`, `plan`, `model`, `audio_status`/`audio_key` from the seed). Reads `templates.json` bundled into the api build.
- [ ] Backfill: a one-off command `bun run --filter @repo/api director:seed-workspaces` copies seeds into existing workspaces missing them (idempotent on `(org_id, video_id)`).
- [ ] Integration test: sign-up → library returns 6 ready seed templates; `indexUsed=false`.

#### Task 2.2.3: Library, index limit, shots, cuts, media procedures
**Files:** `packages/contracts/src/api/director.ts`, `packages/contracts/src/errors.ts`, `apps/api/src/modules/director/*`, `packages/client/src/api/director/*`, `apps/ai/app/director.py`, `apps/ai/app/main.py`.
- [ ] Implement the procedures in the Interfaces block; `index` parses a YouTube URL (watch, shorts, youtu.be), checks `filmable`, counts the user's non-failed `source='user'` plans; unique-violation on the partial index maps to `DIRECTOR_INDEX_LIMIT`. **[RF 3]**
- [ ] Integration tests: `second index by same user → DIRECTOR_INDEX_LIMIT`, `failed index doesn't count`, `concurrent double index → one plan`, `seed copies don't count`, `shots picks highest score and flags needsRetake below 60`, `saveCut rejects another user's file`.
- [ ] Remove the auto-`requestPlan` on the template page (web 2.3 consumes `library`/`index`).

#### Task 2.2.4: Media on Cloud Storage
**Files:** `packages/nest-common/src/storage.ts` (new `GcsStorage` implementing the existing `Storage` seam with `@google-cloud/storage`, ADC, `getSignedUrl` v4 via signBlob), env `STORAGE_PROVIDER=gcs|s3`, `GCS_BUCKET`; ai side reads takes as `gs://` URIs for review.
- [ ] Unit tests with a fake `@google-cloud/storage` client: signed PUT/GET URLs carry the right object key and expiry.
- [ ] Charts/env: production sets `STORAGE_PROVIDER=gcs`, `GCS_BUCKET=director-media-…`; RustFS uploads server stays for local/kind.

#### Task 2.2.5: Build the 6 seed templates
**Files:** create `apps/ai/scripts/build_seeds.py`; output `apps/ai/app/seeds/templates.json` (committed).
- [ ] Indexes each seed with `INDEX_MODEL` via `index_short`, runs `repair_plan`, writes `[{videoId, plan, model, audioKey}]`. Re-run whenever the plan schema changes.

### Workstream 2.3: Web (after 2.2's contract merges)

**Interfaces — Consumes:** 2.2 procedures via `packages/client`; 2.4 `publish` hooks; 2.5 `useLiveCall`.
**Produces:** routes `/` (landing), `/sign-in`, `/library`, `/director/[videoId]` (template), `/director/[videoId]/shoot`, `/director/[videoId]/edit`, `/media`; shared `GeminiLoader` in `packages/ui`.

#### Task 2.3.1: Gemini loader and brand shell
- [ ] `packages/ui/src/components/gemini-loader.tsx`: `<GeminiLoader label?: string size?: "sm"|"md"|"lg" />` (animated conic shimmer + sparkle, `prefers-reduced-motion` respected) and `<GeminiShimmer>` skeleton. Story with `play` test.
- [ ] Replace every spinner/skeleton in `apps/web` with them (`rg "Spinner|animate-spin"` empty).
- [ ] App shell: wordmark "Director", nav Library · My media, user menu; no workspace UI.

#### Task 2.3.2: Landing page
- [ ] `/` (https://director.mmadan.in) is public: no auth gate, no redirect for signed-in users (they see the landing with an "Open Director" button to `/library` instead of "Try the demo"). Check `apps/web/src/proxy.ts` and the marketing route so nothing redirects `/` (owner, 2026-10-18).
- [ ] `apps/web/src/modules/marketing/pages/home.tsx`: hero ("Watch any Short. Shoot your own." + "Try the demo" → `/sign-in?demo=1`), the x-ray moment (a seed's real plan JSON animating a Short into shot cards with framing box, pose, script, camera arrow, then into a phone frame), three steps (Index · Shoot with Gemini · Publish), a live original-vs-take proof, "Built on Google Cloud" strip (Gemini 4 Argon, Gemini Live, Vertex AI, Cloud Run, Cloud Storage, Veo, Lyria, BigQuery, YouTube), the 6 templates, "For platforms" pitch, footer.
- [ ] e2e: landing renders, CTA reaches sign-in.

#### Task 2.3.3: Sign-in with demo credentials and Google
- [ ] Demo card on `/sign-in`: email `demo@director.mmadan.in`, password from env `DEMO_PASSWORD` exposed via `system` (display only), "Use demo account" fills the form; `?demo=1` pre-fills. Google button when `features.google`.

#### Task 2.3.4: Library
- [ ] `/library`: grid of templates (seed badge, shot count, length, status), "Index your own" card: paste URL → `director.index`; while indexing shows stages from realtime `stage` with the Gemini loader; second attempt → modal "You've used your AI credit" (`DIRECTOR_INDEX_LIMIT`), offering the seeds. **[RF 1]** e2e for the modal.
- [ ] Remove the YouTube search feed and `/home`, `/saved`; `/shorts/[id]` redirects to `/director/[id]`.

#### Task 2.3.5: Template page
- [ ] Original player + storyboard (shot cards: purpose, scene, framing box, angle, script; Nano Banana card image and Veo preview when present), audio status note ("original audio couldn't be fetched; the mic will be used"), "Start shooting".

#### Task 2.3.6: Timeline editor
- [ ] `/director/[videoId]/edit`: horizontal timeline of shots (x = time, widths ∝ duration); each shot column stacks its takes vertically (y), Gemini's pick highlighted with a sparkle, `needsRetake` badge with Gemini's feedback and a "Retake" button; a stepper per shot (`‹ take 2 of 5 ›`) changes the pick; preview player plays the assembled cut (existing `edit.ts`/`stitch.ts`); "Save video" renders, uploads (`director-cut-video`), calls `saveCut`. Mobile-first: horizontal scroll-snap per shot, vertical swipe in a column.
- [ ] Component tests: pick changes update preview order; needsRetake badge shows below 60.

#### Task 2.3.7: My media
- [ ] `/media`: cuts grouped by template (template title + thumbnail), each with play, "Publish to YouTube" (2.4), publish status chip.

### Workstream 2.4: Google sign-in and YouTube publish (api + web)

**Interfaces — Produces:** `publish.copy` POST `/media/{cutId}/publish-copy` → `{title, description, hashtags: string[], credits: string}` (Gemini Flash via ai `/v1/director/publish-copy`); `publish.upload` POST `/media/{cutId}/publish` `{title, description, hashtags, visibility: "unlisted"|"private"|"public"}` → `DirectorCut` (publish status). Error codes `PUBLISH_DEMO_DISABLED`, `PUBLISH_NEEDS_YOUTUBE` (403, client starts consent), `PUBLISH_CUT_NOT_READY`.

#### Task 2.4.1: Google sign-in
- [ ] Owner creates OAuth client (lead gives steps: consent screen External + "In production", scopes `openid email profile`; web client with redirect `https://director.mmadan.in/api/auth/callback/google`; YouTube scope requested incrementally). Secrets `GOOGLE_CLIENT_ID/SECRET` into `api.sops.yaml`.
- [ ] Integration test (fake Google): Google sign-in creates a user with a personal workspace and 6 seeds.

#### Task 2.4.2: Publish
- [ ] Web: Publish sheet shows the video, editable title/description/hashtags/credits, visibility (default unlisted); if `PUBLISH_NEEDS_YOUTUBE`, calls better-auth `linkSocial({provider: "google", scopes: ["https://www.googleapis.com/auth/youtube.upload"]})` then retries.
- [ ] API: reads the cut from storage, resumable `videos.insert` (`part=snippet,status`, `snippet.title` gets ` #Shorts`, `description` ends with credits + original link, `status.privacyStatus`, `status.selfDeclaredMadeForKids=false`) with the user's Google access token (better-auth `getAccessToken`, refreshes). Records publish status; emits BigQuery event.
- [ ] Integration tests (fake YouTube): demo user → `PUBLISH_DEMO_DISABLED` **[RF 5]**; missing file → `PUBLISH_CUT_NOT_READY` **[RF 5]**; success stores `youtubeVideoId`.

### Workstream 2.5: Gemini video call (Live API relay)

**Interfaces — Produces:** WebSocket `wss://director.mmadan.in/api/live?videoId=…&shot=n` (session cookie auth, `inOrg`). Client → server messages: `{type:"audio", pcm16: base64}` (16 kHz mono), `{type:"frame", jpeg: base64}` (≤ 1 fps), `{type:"text", text}`. Server → client: `{type:"audio", pcm16}` (24 kHz), `{type:"transcript", who:"you"|"director", text}`, `{type:"tool", name:"start_recording"|"stop_recording"|"next_shot"|"retake"|"previous_shot", args}`, `{type:"error", code}`. Web hook `useLiveCall({videoId, shotIndex, onTool}) → {state:"idle"|"connecting"|"live"|"ended"|"failed", start(), end(), muted, toggleMute()}`.

#### Task 2.5.1: Relay in the api
**Files:** create `apps/api/src/modules/live/live.gateway.ts` (Fastify websocket route), `live.relay.ts` (upstream client to `wss://{LOCATION}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent` with an OAuth token from the metadata server, setup message with `model: projects/{p}/locations/{l}/publishers/google/models/{LIVE_MODEL}`, `responseModalities: ["AUDIO"]`, input/output transcription on, system instruction built from the plan + current shot, the five tools as function declarations), rate limit 1 concurrent call per user, max 10 minutes.
- [ ] Unit tests with a fake upstream WebSocket: setup carries the shot's script and tools; audio and frames are forwarded; upstream tool call → client `tool` message; upstream close/token error → client `error` then close. **[RF 4]**

#### Task 2.5.2: Call screen
**Files:** `apps/web/src/modules/director/hooks/use-live-call.ts`, `components/live-call.tsx`, shoot page integration.
- [ ] Audio capture via AudioWorklet (PCM16 16 kHz), playback queue at 24 kHz, barge-in (stop playback on user speech), frames from the existing camera stream at 1 fps.
- [ ] UI: full-screen camera, Gemini orb (animated by output level), captions for both sides, mute/end buttons, the existing guides layered on top; tool messages drive the existing recorder/shot navigation.
- [ ] On permission denied / socket failure / `error`: toast + fall back to Director Live on the same shot; takes already recorded stay. **[RF 4]** Component test with a fake socket.

### Workstream 2.6: Google extras (ai + api)

#### Task 2.6.1: Gemini TTS for guides
- [ ] ai `POST /v1/director/speak {text, voice}` → `audio/wav` via `gemini-3.8-flash-tts`; api `director.speak` proxies; web uses it instead of `speechSynthesis` when not in a live call (cached per line).

#### Task 2.6.2: BigQuery events
- [ ] api `AnalyticsService.record(kind, fields)` inserting into `director.events` via `@google-cloud/bigquery` (ADC), fire-and-forget, disabled when `BIGQUERY_DATASET` unset. Kinds: `indexed`, `take_reviewed`, `cut_saved`, `published`, `call_started`. Lead builds a Looker Studio report on it.

#### Task 2.6.3: Seed media: Veo clips, Nano Banana storyboard cards, Lyria score
- [ ] `apps/ai/scripts/seed_media.py`: for each seed shot, Nano Banana 2.1 storyboard image → `gs://…/seed-media/<videoId>/shot-<n>.png`; Veo 3.1 Lite 4–6 s preview → `…/shot-<n>.mp4`; Lyria track per seed matched to mood/tempo → `…/music.wav`. Writes keys into `templates.json` (`shots[n].storyboardKey`, `previewKey`; `musicKey`). Budget cap: ≤ 40 Veo clips.
- [ ] Contract adds optional `storyboardUrl`, `previewUrl` per shot and `musicUrl` per plan (signed GET URLs from 2.2.4).

---

## Phase 3 — Demo account, deploy, verify (lead)

### Task 3.1: Demo account
- [ ] `bun run --filter @repo/api director:demo-account` (refuses outside production unless `--force`): creates/updates `demo@director.mmadan.in`, verified email, password `DEMO_PASSWORD`, user flag `demo=true` (blocks publish), copies seeds. `DEMO_PASSWORD` in `api.sops.yaml`.

### Task 3.2: Ship
- [ ] Merge order: 1.x → 2.2 → (2.1, 2.3, 2.4, 2.5, 2.6) → infra values. Each PR green on CI.
- [ ] Release: master images signed (classic format) → `release.yaml` `imageTag: sha-<commit>`; turn the image policy back on (`tofu apply`).
- [ ] Deploy Cloud Run indexer with the same image tag; set `INDEXER_URL` in ai secrets.

### Task 3.3: End-to-end verification
- [ ] Run `apps/ai/evals/index_shorts.py --live` (12/12).
- [ ] Manual on a phone: landing → demo sign-in → library (6 seeds) → index a Short (stages) → second index → credits modal → template → live call (voice commands record shots) → edit (picks, retake suggestion) → save → My media → publish from a Google account (unlisted) → video appears on YouTube.
- [ ] Owner records takes on the demo account for judges.
