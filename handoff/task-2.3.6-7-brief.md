# Tasks 2.3.6 + 2.3.7: timeline editor and My media

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

### Workstream 2.3: Web (after 2.2's contract merges)

**Interfaces — Consumes:** 2.2 procedures via `packages/client`; 2.4 `publish` hooks; 2.5 `useLiveCall`.
**Produces:** routes `/` (landing), `/sign-in`, `/library`, `/director/[videoId]` (template), `/director/[videoId]/shoot`, `/director/[videoId]/edit`, `/media`; shared `GeminiLoader` in `packages/ui`.


#### Task 2.3.6: Timeline editor
- [ ] `/director/[videoId]/edit`: horizontal timeline of shots (x = time, widths ∝ duration); each shot column stacks its takes vertically (y), Gemini's pick highlighted with a sparkle, `needsRetake` badge with Gemini's feedback and a "Retake" button; a stepper per shot (`‹ take 2 of 5 ›`) changes the pick; preview player plays the assembled cut (existing `edit.ts`/`stitch.ts`); "Save video" renders, uploads (`director-cut-video`), calls `saveCut`. Mobile-first: horizontal scroll-snap per shot, vertical swipe in a column.
- [ ] Component tests: pick changes update preview order; needsRetake badge shows below 60.

#### Task 2.3.7: My media
- [ ] `/media`: cuts grouped by template (template title + thumbnail), each with play, "Publish to YouTube" (2.4), publish status chip.

## Controller rulings for this task

- The `director-cut-video` file purpose caps at 100 MB (ClamAV's default stream limit; the worker buffers the file). Render the cut so a 3-minute Short stays under it: ~720x1280, H.264/AAC (or VP9/Opus where the browser can't do H.264 in MediaRecorder), video bitrate ≈ 4 Mbps. If the purpose's limit in packages/contracts still says 200 MB when you start, lower it to 100 MB in this task.

- packages/client hooks for cuts/media land here with the pages that use them (knip refuses unused hooks).
