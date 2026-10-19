# Tasks 2.1.3 + 2.1.5: indexing stages, failure reasons, and the Cloud Run indexer

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

### Workstream 2.1: Indexing (apps/ai) and the Cloud Run indexer

**Interfaces — Produces:**
- `POST /v1/index` on a new ASGI app `app.indexer:app` (Cloud Run): body `{videoId: str, orgId: UUID, planId: UUID}`; returns `IndexResult {plan: ShotPlan, model: str, audio: {status: "ready"|"failed", objectKey: str|None}}`. Auth: Google ID token, audience = service URL (Cloud Run `--no-allow-unauthenticated`).
- Env (ai): `INDEX_MODEL`, `INDEXER_URL` (empty → index in-process), `MEDIA_BUCKET`.
- Worker publishes realtime `director.changed` with `stage`: `queued | watching | writing | ready | failed`.


#### Task 2.1.3: Indexing stages and failure reasons
**Files:** `apps/ai/app/director.py`, `apps/ai/app/worker.py`, tests.
- [ ] Publish stage at queue (`queued`), before the Gemini call (`watching`), after the response (`writing`), on save (`ready`), on failure (`failed` + error code).
- [ ] Refusals for private/removed/age-restricted/not-found map to `DIRECTOR_VIDEO_UNAVAILABLE`; too long → `DIRECTOR_TOO_LONG` (existing filmable check). A failed user index **does not count** toward the limit (2.2 counts only non-failed). **[RF 1]**


#### Task 2.1.5: Cloud Run indexer
**Files:** create `apps/ai/app/indexer.py` (FastAPI `app` with `POST /v1/index` and `/health/live`), `apps/ai/app/google_auth.py` (`async def id_token(audience: str) -> str` from the metadata server; `async def access_token() -> str`), worker change in `apps/ai/app/director.py` `analyze`: if `INDEXER_URL` set, POST there with the ID token; else run the same function in-process.
- [ ] Shared `async def index_short(video_id) -> IndexResult` used by both paths.
- [ ] Tests: in-process path writes the plan; remote path sends `Authorization: Bearer <token>` and saves the returned plan (fake HTTP server).
- [ ] Deploy (lead): mirror the `ai` image `sha-<commit>` from GHCR to Artifact Registry (`gcloud artifacts docker images copy` or `crane copy`), then `gcloud run deploy director-indexer --image … --command uvicorn --args app.indexer:app,--host,0.0.0.0,--port,8080 --service-account director-indexer@… --no-allow-unauthenticated --region us-central1 --timeout 900 --memory 2Gi --set-env-vars INDEX_MODEL=gemini-4-argon,MEDIA_BUCKET=…,GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=…,GOOGLE_CLOUD_LOCATION=global`; grant `director-vm` `run.invoker`. Add the command to `docs/deploy.md`.

