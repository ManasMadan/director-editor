# Task 3.4 report: docs a judge reads

Status: DONE_WITH_CONCERNS

(Written inside the worktree: the isolation guard refused the shared checkout's
.superpowers path. Not committed.)

Branch: worktree-agent-a57c7a17904d25960, reset to origin/feat/mm/director-hackathon
(4f23bd5) first. Commit range: 4f23bd5..12af1e1 (one commit, `docs(docs): rewrite the
README around Director, and explain how it works underneath`, --no-verify).

## What changed

- `README.md`, rewritten for Director: pitch; "Try it" (live URL; demo credentials only
  referenced as being on the sign-in page, never written); screenshot gallery with the 7
  filenames (`docs/images/{landing,library,template,call,editor,media,publish}.png`) and
  `<!-- screenshots added after deploy -->`; the 7-step creator workflow; "Built on Google
  Cloud" table (service, what it does, file that calls it); Mermaid architecture diagram;
  "How indexing works" and "How the live call works" summaries linking to the details;
  run locally; repository map; "The engineering underneath" with the Scaling path table.
- `docs/how-it-works.md` (new, in docs/README.md's index): indexing (asking, the one-Short
  limit, stages, where it runs incl. Cloud Run + ID tokens, the Gemini call: video/*, 3 fps,
  medium resolution, prompt, schema/ShotPlanDraft; retries + gemini-3.1-pro-preview
  fallback; repair_plan steps; audio capture; the 12-Short eval with the 2026-10-18 12/12
  result; starter templates and their Veo/Nano Banana/Lyria media), the live call (relay,
  auth, setup message, audio/frame formats table, relay budgets, 5 tools table, one call
  across the Short, fallback), Director without a call (scene checks, TTS caching), takes
  and best-take pick (<60 retake), editor and browser render, My media, publish, analytics.
- `docs/architecture.md`: diagram adds the Cloud Run indexer and Google services; table rows
  for api/ai updated, a `director-indexer` row; the "only direct service-to-service call"
  sentence now includes worker -> indexer; a production paragraph (one GCE VM, k3s, Argo
  CD, Cloudflare, CloudNativePG, RustFS for backups copied offsite to GCS, Kyverno-signed
  images, Stalwart via Resend, metadata-server credentials); glossary "Stand-in" now says
  fake-google is test-only.
- `docs/director.md`: intro links how-it-works; "Turning it on" block adds
  `GOOGLE_CLOUD_PROJECT` (required with GOOGLE_VERTEX=true once a key is set); seams table
  rows for voice/hearing/scene now reflect TTS and the live call; the "Director never
  downloads a YouTube video" sentence corrected (audio is captured with yt-dlp); demo
  publish refusal code changed to `PUBLISH_DEMO_DISABLED` with a verify marker.
- `docs/deploy.md`: opening paragraph no longer says nothing is managed / RustFS-only;
  names Cloud Storage, BigQuery and Cloud Run for production.
- `CONTRIBUTING.md`: gained the "Everyday commands" table moved from the README.
- `docs/README.md`: intro updated, how-it-works row, architecture row mentions production,
  and the "Working with Claude Code" paragraph moved here from the README.
- `CLAUDE.md`: unchanged (nothing in it is wrong now).

## Decisions the brief didn't make

- Kept the "Scaling path" table in the README (under "The engineering underneath"). It is
  referenced as living in the README by CLAUDE.md, `.claude/rules/docs.md`,
  `.claude/agents/docs-sync.md`, 11 `swap-*` skills, add-seam, remove-feature and
  architecture.md; moving it means editing Claude guard-rail files. It also describes how
  Director itself scales (GCS, BigQuery), so it isn't pure starter material.
- Moved out of the README: Day 1 setup details (already in CONTRIBUTING), Going to
  production (docs/new-project.md, linked), Shipping (docs/deploy.md, linked), Everyday
  commands (to CONTRIBUTING), Working with Claude Code (to docs/README.md).
- Compute Engine and Artifact Registry have no code that calls an API: the table cites the
  metadata-server client and production values for Compute Engine, and docs/deploy.md's
  indexer section for Artifact Registry.
- Veo/Nano Banana/Lyria are stated honestly as run once from a developer's machine
  (`seeds:media`), served by the app afterwards.
- Added deploy markers too (`<!-- verify after deploy: INDEXER_URL set -->` /
  `... set in production -->`) wherever the docs say indexing runs on Cloud Run in
  production: on this branch `deploy/environments/production/stack.yaml` still leaves
  INDEXER_URL unset (indexing in the worker).

## Markers for the controller

- `<!-- verify after publish merges -->`: README step 7; README Google table rows for
  Gemini 3.8 Flash (YouTube post), YouTube Data API (upload, and the path
  `apps/api/src/modules/publish/youtube-upload.ts`), Google sign-in (youtube.upload);
  how-it-works "Publishing to YouTube Shorts" (cites `apps/ai/app/publish_copy.py`,
  `apps/api/src/modules/publish/youtube-upload.ts`,
  `apps/web/src/modules/director/components/publish-sheet.tsx`, `PUBLISH_NEEDS_YOUTUBE`,
  `PUBLISH_DEMO_DISABLED`, `PUBLISH_CUT_NOT_READY`, a `published` BigQuery event); director.md
  demo bullet. These paths/codes come from the publish commits on
  worktree-agent-a8de707cda903e3e5 (9fb001a, d9268a2, ec05658), not yet on the
  integration branch. When publish merges, also add `published` to the BigQuery event lists
  (README table, how-it-works "Product analytics") and check `DIRECTOR_TOKENS_PER_PUBLISH_COPY`
  is in docs/environment.md.
- `<!-- verify after deploy: INDEXER_URL set ... -->`: README step 1 and "How indexing
  works"; how-it-works "Where it runs"; architecture.md production paragraph.
- `<!-- verify after the template page shows seed media -->`: how-it-works "The 6 starter
  templates". The API serves `storyboardUrl`/`previewUrl`/`musicUrl` on `director.plan`,
  but no web code reads them yet (the polish brief's item 1). I didn't claim the template
  page shows them anywhere.

## Checks (docs-sync by hand)

- Every backticked path in the changed docs exists (script over README, how-it-works,
  architecture, director, docs/README, CONTRIBUTING, deploy), except the three publish files
  above (marked).
- Commands: `bun run setup`, `bun dev:full`, `bun run doctor`, `bun run env:set`, the
  CONTRIBUTING table's scripts, and `bun run --filter @repo/ai evals:index | seeds:build |
  seeds:media` are all in a package.json.
- Every env var named is in `docs/environment.md` and in `apps/api/src/env.ts` or
  `apps/ai/app/settings.py`; defaults stated match (INDEX_MODEL gemini-4-argon,
  INDEX_FALLBACK_MODEL gemini-3.1-pro-preview, LIVE_MODEL gemini-live-2.5-flash-native-audio,
  LIVE_LOCATION us-central1, TTS_MODEL gemini-3.8-flash-tts). Error codes named exist in
  `packages/contracts/src/errors.ts` (PUBLISH_* marked).
- Numbers checked against code: 3 fps / medium resolution / medium thinking, 2 retries at
  1 s and 2 s, BullMQ 3 attempts, repair thresholds (0.3 s, 0.5 s, 12 shots), 180 s Short,
  audio timeout 120 s, 20 calls/hour, 10-minute call, frame 640 px/1 per s, 16 kHz up /
  24 kHz down, ~100 ms chunks, voice Sulafat, 5 tools, take 60 s/15 MB, review download
  16 MB, signed take read 30 min, retake below 60, render 720x1280 @ 30 fps ~4 Mbit/s +
  128 kbit/s, cut upload 100 MB, 35 storyboard cards/clips across the 6 seeds.
- Anchors used (`#indexing-a-short`, `#the-live-call`, `#where-it-runs`,
  `#the-originals-audio`, `#publishing-to-youtube-shorts`, director.md `#turning-it-on`,
  `#the-screens-appsweb`, deploy.md `#the-cloud-run-indexer`) match their headings.
- Lines: every prose line I wrote or reflowed is at most ~90 characters (tables, HTML and
  pre-existing lines aside).
- `bun run lint:patterns` -> "no ruled-out code patterns"; `bun run lint:markers` -> "no
  ponytail: markers in tracked source"; `bun run lint:suppressions` -> passed;
  `bun test scripts/env-docs.test.ts scripts/devcontainer.test.ts scripts/claude-setup.test.ts`
  -> 91 pass after `bun run gen` (the first run failed only because the fresh worktree had
  no generated Prisma client).

## Couldn't verify

- The Mermaid diagrams weren't rendered (no mermaid CLI installed; adding one needs
  approval). I quoted every label containing a colon; worth a glance on GitHub.
- The 12/12 evaluation result (2026-10-18) comes from the task 2.1.6 report's live run, not
  from anything in the repository.
- `DIRECTOR_MODEL=gemini-3.8-flash` in production is encrypted in
  `deploy/environments/production/secrets/ai.sops.yaml`; I took the model name from the
  brief (its ciphertext length matches).
- Whether the live production site matches (demo account seeded, call working, Cloud Run
  indexer deployed, `director.events` populated): not checked against
  https://director.mmadan.in.
- Whether a Looker Studio report exists: I avoided claiming one.
