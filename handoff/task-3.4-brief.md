# Task 3.4: docs a judge reads

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


### Task 3.4: Docs a judge reads (owner, 2026-10-18)

A judge has only the repository and https://director.mmadan.in. Everything they need to
understand, try and assess Director is reachable from the README in a few minutes.

- [ ] `README.md` rewritten for Director: one-paragraph pitch; the live URL and the demo
  credentials; the full user workflow (index → template → Gemini video call → takes →
  timeline editor → My media → publish to YouTube Shorts) with screenshots captured by the
  Playwright run against production (`docs/images/`); a "Built on Google Cloud" table
  listing every Google service used, what it does in Director and the file that calls it
  (Vertex AI Gemini 4 Argon and 3.8 Flash, Gemini Live, Gemini TTS, Veo, Lyria, Nano
  Banana, Cloud Run, Cloud Storage, Artifact Registry, BigQuery, YouTube Data API, Google
  sign-in, Compute Engine); an architecture diagram (Mermaid) of web, api, ai service and
  worker, the Cloud Run indexer, the Live relay, Postgres/Valkey, GCS and Vertex; how
  indexing works (prompt, schema, repair, stages, fallback) and how the live call works
  (relay, audio formats, tools); how to run it locally; the repository map. Starter-kit
  material that isn't about Director moves out of the README into `docs/`.
- [ ] `docs/architecture.md` brought in line with the code; a new `docs/how-it-works.md`
  (indexing pipeline, live call, take review and best-take pick, editor, publish) if the
  README would otherwise get too long. Every claim checked against the code
  (`.claude/rules/docs.md`); run the `docs-sync` agent after.
