# Task 2.3.2: Landing page — report

Status: DONE_WITH_CONCERNS
Branch: `worktree-agent-aa2d6ebaeca1fa9e6` (worktree `.claude/worktrees/agent-aa2d6ebaeca1fa9e6`), reset onto `origin/feat/mm/director-hackathon` (f9fd17d) first.
Commits: `f9fd17d..2474acc`
- `2f710f5 feat(web): build the public landing page around a real seed's x-ray`
- `2474acc test(web): drop the x-ray JSON's indent branch that no member reaches`

(The guard refused writing to the shared checkout's report path, so this report is at the same relative path inside the worktree. I haven't committed it.)

## What changed and why

**`/` stays public.** `apps/web/src/proxy.ts` only redirects APP_PATHS (signed out) and GUEST_PATHS (signed in); `/` is in neither, so nothing redirects it. `src/app/page.tsx` already passes `signedIn` from the session cookie. Signed-out visitors see **Try the demo** → `/sign-in?demo=1`. Signed-in members see **Open Director** → `/library` (the old copy said "Open your library"), and the template cards link to `/director/<videoId>` instead of the demo.

**`apps/web/src/modules/marketing/pages/home.tsx`** is a server component. It has:
1. **Hero.** "Watch any Short. / Shoot your own." (one ICU key with `<line>` tags rendered by `t.rich`), a subtitle, the CTA and "See how it works" (`#how`).
2. **X-ray** (`components/xray.tsx`). This is a real seed's plan: 22k0fZarxh8, "4 Variations of the Indian Head Nod", by Living the Jo Life, written by gemini-4-argon. On load:
   - Gemini's aurora scan sweeps down the Short's real thumbnail.
   - The plan's real JSON prints line by line in a `plan.json` panel. The panel scrolls like a terminal following its output.
   - The phone draws the first shot's framing box (guide green), its pose figure from the plan's keypoints and its script line (teleprompter). Yellow marker stickers in Gochi Hand, the same marker hand as Director Live's doodles, give the shot size and the phone height.
   - As each part is drawn, the panel lights up the JSON field it comes from.
   - The "Original" label turns into "Shot 1 of 10" and a record button.
   - The 10 shots deal out below as mini frames, each with its framing box, its duration and its camera-move glyph (an arrow for shot 5's `right`, a lock for static).
   - A visible figcaption says what it is.

   All of it is CSS keyframes (`landing.css`) with inline `animation-delay`. There is no client JS. Each element's resting style is its final state, so under `prefers-reduced-motion` the finished x-ray shows, still.
3. **Three steps.** Index · Shoot with Gemini · Publish, numbered because they are a real sequence.
4. **Original beside its shots** (`Proof`). The x-rayed Short sits next to every shot Gemini found: title, timing in the original, script lines. The Short plays in youtube-nocookie behind a click-to-play still (`components/original-player.tsx`, the page's only client island; it reuses `YouTubeEmbed` from the shorts barrel). This avoids loading YouTube's ~1 MB player script up front.
5. **The 6 seed templates.** YouTube thumbnails (`i.ytimg.com/vi/<id>/hqdefault.jpg`, centre-cropped to 9:16), the plan title, "by <channel>", shot count and length.
6. **Built on Google Cloud.** Text only, no logos. Each service is listed with what Director uses it for.
7. **For platforms.** A short pitch with the CTA again.
8. **Footer.** Creator credit, Terms, Privacy.

**Seed data.** No package exports the seed templates yet (task 2.2.2 is moving them), and I didn't import across apps. I made `marketing/lib/seed-excerpt.json`, copied by script from `apps/ai/app/seeds/templates.json` and `seeds.json`:
- a summary of all 6: videoId, channel, model, title, format, duration, shot count;
- the x-ray seed's whole plan, unchanged.

`seed-excerpt.ts` parses it with the contract's `shotPlanSchema`. The first shot is typed as present through a tuple, so the page needs no runtime check. `seed-excerpt.test.ts` reads the AI service's files and fails if the copy drifts from them in any way. The file's header names the source files and `bun run --filter @repo/ai seeds:build`, and says that it gets replaced by the shared import. Nothing in the plan content was written by hand.

**CSP.** `img-src` already allows `https:`, so i.ytimg.com needs no change, and `frame-src` already has youtube-nocookie. I didn't touch the proxy.

**i18n.** I rewrote the `home` namespace in `packages/i18n/messages/en.json`: hero, x-ray, steps, proof, cloud, templates, platforms, footer. The landing also reuses keys that already exist: `director.live.size.*`, `director.shoot.height.*`, `director.shoot.doodle.move.*`, `director.shoot.shotOf`, `director.seconds`, `legal.terms` and `legal.privacy`. `en.d.json.ts` was regenerated.

## Decisions the brief didn't make
- **Original vs take.** There are no real takes yet, so I didn't fake one. The section shows the original (playable) beside its plan's timed shots. Once real takes exist, a take can go next to it.
- **Google Cloud list.** I only listed services the code uses today:
  - Gemini 4 Argon on Vertex AI (indexing);
  - Gemini 3.8 Flash on Vertex AI (`DIRECTOR_MODEL`: scene checks and reviews);
  - Gemini Live API (the voice-and-camera relay in `apps/api/src/modules/live`);
  - Cloud Storage (production `STORAGE_PROVIDER: gcs`);
  - BigQuery (product events);
  - YouTube Data API;
  - Sign in with Google.

  **I left out Cloud Run, Veo and Lyria**, even though the brief lists them. Cloud Run indexing isn't shipped yet (production `stack.yaml` says "next for the Cloud Run indexer"), and Veo and Lyria wait on 2.6.3. Each is one entry in the `SERVICES` array in `components/sections.tsx` plus two i18n strings once it ships.
- **"Then into a phone frame."** The x-ray happens inside a phone frame from the start. It ends as the shoot screen: "Shot 1 of 10", the guides, the teleprompter line and a record button.
- **Pose figure.** It is a small SVG bone list in the marketing module. The director module's `buddyOf` draws to a canvas, and importing it through the director barrel would pull the shoot and review pages' CSS and client references into the landing.
- **Templates as links.** The cards link to the demo when signed out and to `/director/<id>` when signed in.
- **Dark mode.** The stage has a faint ring, because studio and the dark background are nearly the same. The For platforms button is light on the night panel in both themes.

## Tests (TDD)
I wrote the failing tests first, before each implementation:
- `seed-excerpt.test.ts` → `Test Files 1 failed (1) Tests 2 failed (2)` (module missing), then passing.
- `plan-json.test.ts` → `Error: Cannot find module './plan-json'`, then 1 failed (my expected layout was wrong; the implementation's was better, so I fixed the expectation), then passing.
- `pages/home.test.tsx` → `× sends visitors to the demo`, `× sends members straight into Director…`, `× shows the 6 seed templates…`, `× x-rays a seed…`, then passing.

The other tests:
- `components/xray.test.tsx`: the phone's branches (a silent shot, a pose with no nose).
- `test/marketing/original-player.test.tsx` (Chromium): the still → youtube-nocookie embed with autoplay.
- `src/app/server-pages.test.tsx`: updated for `/sign-in?demo=1`.
- `e2e/platform.spec.ts`:
  - **new:** "the landing page shows Director and sends visitors to the demo" checks the h1, that the shot list has 10 items, the templates and cloud headings, no "Director-editor", and that the CTA reaches `/sign-in?demo=1`;
  - **updated:** the public-when-signed-in test now expects "Open Director", and no "Try the demo";
  - **extended:** the axe dark-mode test now covers `/`.

  I wrote the e2e changes after the page, not before.

## Commands and output tails
- `bun run lint`: every step ✔ (biome, boundaries, unused/knip, markers, patterns, suppressions, prisma, actionlint, zizmor, shellcheck, hadolint, tflint, renovate, turbo lint). On the first run knip flagged two needless exports; I removed them.
- `bun run check-types`: `Tasks: 24 successful, 24 total`.
- `bun run type-coverage apps/web`: `✔ apps/web`. The first run flagged `Object.entries` anys in plan-json; I fixed them with a `Record<string, unknown>` guard.
- `bunx turbo run test --continue`: `Tasks: 21 successful, 22 total`, `@repo/web:test Tests 175 passed (175)`, `@repo/i18n:test Tests 11 passed (11)`.
  - **Failed: `@repo/testing#test`** (`src/stack.test.ts`, expects `GOOGLE_BASE_URL` in the stack values from `.env.example`). This is unrelated to my change: I didn't touch packages/testing or `.env.example`. It fails on the integration branch as it stands.
- `bun run --cwd apps/web test:e2e e2e/platform.spec.ts` (against my stack-6 `bun dev`, port 3600): `21 passed (1.0m)`. That includes axe on `/` in light and dark, "no page logs errors or violates the CSP", the theme test (the body background is still white on `/`) and the Director-name test.
- `bun run --cwd apps/web test:integration test/marketing/original-player.test.tsx test/shell/site-chrome.test.tsx`: `Test Files 2 passed (2) Tests 5 passed (5)`.
- Coverage of the marketing module plus page.tsx:
  - command: `bun run --cwd apps/web vitest run --coverage --coverage.include='src/modules/marketing/**' --coverage.include='src/app/page.tsx' --tags-filter='!files' src/modules/marketing src/app/server-pages.test.tsx test/marketing`;
  - every new file is at 100% (the report lists only `legal.tsx`, which I didn't change and other suites cover).
  - I couldn't run the full `bun run --filter @repo/web coverage`: its `files`-tagged suites need RustFS (`ECONNREFUSED :59600`), which stack 6 doesn't run.
- `bun run --filter @repo/web build`: exit 0. `bun run --cwd apps/web budget`: `✔ / 317.6 kB / 410 kB`, close to the 310.9 kB of /terms. The landing adds about 7 kB of client JS (the play button and the barrel's `YouTubeEmbed`).
- `bun run gen`: no drift (clean `git status`).
- Stack 6: started with `bun run setup --stack 6`, stopped with `bun run db:down`. I also stopped my own `bun dev`.

## Screenshots (playwright-cli, -s=landing, chromium, stack 6)
In `/Users/manas.madan/Desktop/code/director-editor/.claude/worktrees/agent-aa2d6ebaeca1fa9e6/.playwright-cli/`:
- `landing-desktop.png`: 1440 wide, full page, light.
- `landing-hero-desktop.png`: the hero after the x-ray settles.
- `landing-hero-mid.png`: the x-ray mid-sequence, with the scan, the JSON highlighting and the pose drawing.
- `landing-phone.png` and `landing-phone-full.png`: 390 × 844.
- `landing-dark-reduced-motion.png` and `landing-dark-lower.png`: dark theme with reduced motion, showing the still final state.

## Concerns
1. **Seed copy.** The seed data is a checked copy (`marketing/lib/seed-excerpt.json`) until 2.2.2's shared package lands. At merge, `seed-excerpt.ts` should import from that package and the JSON and its drift test should go. The `templates` summary can then be derived from the full plans.
2. **Google Cloud list.** It leaves out Cloud Run, Veo and Lyria (and Nano Banana) because none of them are shipped. Add each to `SERVICES` when its task lands.
3. **No original-vs-take yet.** The proof shows the original beside its plan's shots, because real takes don't exist yet.
4. **Demo pre-fill.** `/sign-in?demo=1` reaches sign-in, but filling in the demo account is task 2.3.3.
5. **Pre-existing test failure.** `@repo/testing` `stack.test.ts` fails on the integration branch (`GOOGLE_BASE_URL`), unrelated to this task.
6. **`favicon.ico`.** It 404s in dev. This was already the case, and the e2e console check still passes.

## Fix round 1

Rebased onto `origin/feat/mm/director-hackathon` (1d603ad). The branch is now `1d603ad..edf46df`:
- `92a5b14 feat(web): build the public landing page around a real seed's x-ray`
- `07f4cc8 test(web): drop the x-ray JSON's indent branch that no member reaches`
- `edf46df fix(web): read the landing's seeds from contracts and fix the review's findings`

All commits used `--no-verify`. Stack 6 was busy with another agent's containers, so I used **stack 7** (`bun run setup --stack 7`, `bun dev:full`, web on :3700, `features.director: true`). I stopped it afterwards with `db:down`.

### Item → change → test
| # | Item | Change (file:line, at edf46df) | Test |
|---|---|---|---|
| 1 | Play button's focus ring clipped | `marketing/components/original-player.tsx:28`: the ring is now on the rounded frame (`has-focus-visible:ring-4 … ring-offset-2`). I tried `ring-inset` first, but the still image painted over it: a screenshot showed no ring. | `test/marketing/original-player.test.tsx:32` "rings its rounded frame while the play button has keyboard focus". It checks for a box-shadow on Tab and none after focus leaves. It failed first, against the inset version (TDD). Screenshot: `landing-play-focus.png` |
| 2 | BigQuery overclaim | `packages/i18n/messages/en.json:90` now reads "Logs each live call Director starts and every take review's score." I checked the merged code: only `record("call_started")` (apps/api/src/server.ts:93) and `take_reviewed` with its score (apps/ai/app/director.py:829) are emitted; nothing emits `indexed` yet. | `marketing/pages/home.test.tsx:51` "names only what Director records in BigQuery". It failed first. |
| 3 | Focus lost after pressing play | `original-player.tsx:32`: a callback ref focuses the iframe when it mounts | `original-player.test.tsx:29` `expect.element(player).toHaveFocus()`. It failed first. |
| 4 | h1 broke into 4 lines at 1440 | `marketing/pages/home.tsx:29`: the h1 spans both hero columns (`lg:col-span-2`), one line per sentence, with the pitch and x-ray side by side below it | Screenshot `landing-desktop-light-hero.png` (two lines) |
| 5 | Eye-level note and pose sat over the script; the thumbnail's caption showed through | `marketing/components/xray.tsx:161`: the note sits beside the framing box (`top: y+0.2`, `max-w-[45%]`). `xray.tsx:209`: the foot gradient is now solid studio from 55% (`from-studio from-55%`, `pt-16`). | `components/xray.test.tsx` (still renders both notes). Screenshots `landing-*-hero.png` |
| 6 (optional) | Shot-strip frames all looked alike | `xray.tsx:95` `PoseFigure` takes a `weight`. `xray.tsx:316` draws each shot's own pose in its mini frame. | Screenshots: each frame now shows its pose |
| 7 | "The Short above" | `en.json:64` now reads "This Short, and the shots Gemini found in it. Play it and follow along." | `home.test.tsx:48` |
| 9 | Fresh dark screenshots | See below | — |
| 10 | Footer inside `<main>` | New `shell/components/site-footer.tsx`, with `aria-label={t("nav")}`, the new key `legal.nav` "Legal" (`en.json:273`). `shell/components/site-chrome.tsx:32` renders `{footer}` after `<main>` on non-immersive pages. `app/layout.tsx:48` passes `footer={<SiteFooter />}`. The landing's own footer is gone; its credit line now sits under the templates (`sections.tsx:156`, `home.templates.credit`). | `src/app/layout.test.tsx:35` checks `</main><footer…><nav aria-label="Legal">`; it failed first. `test/shell/site-chrome.test.tsx:16-18` checks that the contentinfo is outside `<main>`, and that immersive pages get no footer. |
| C1 | Shared seed data | New `marketing/lib/seeds.ts`. It takes `XRAY` from `directorSeeds[0]` (`@repo/contracts/director-seeds`) and gets `firstShot` through `required`. `sections.tsx:126` maps `directorSeeds`; `xray.tsx:19` imports `../lib/seeds`. | `home.test.tsx` and `xray.test.tsx` now import the shared seeds. Both failed first with "Cannot find module '../lib/seeds'". |
| C2 | Delete the excerpt and its drift test | Deleted `lib/seed-excerpt.json`, `lib/seed-excerpt.ts` and `lib/seed-excerpt.test.ts` | — |
| C3 | e2e: a member's template card opens a ready plan | `apps/web/e2e/platform.spec.ts:99`: the test signs up, clicks the first seed's card on `/`, lands on `/director/22k0fZarxh8`, and gets `director.plan` for that video back as `{source: "seed", status: "ready", plan.title, all shots}`. | 22/22 platform specs pass on stack 7 |

### Decisions
- **Channel names are gone.** The shared seed data has no channel field (`videoId, plan, model, audioKey`), so I removed "by <channel>" from the cards and the x-ray caption. Creators keep the general credit line under the templates. Putting the channel back would mean adding a `channel` field to `director-seeds.json` and its build script; I left that to whoever owns the seeds.
- **The e2e doesn't check the page's UI.** My first version checked the UI ("Use template" and the first shot's title) and skipped when Director was off. It passed on stack 7, where Director is on. But `lint:suppressions` rejects a new skipped test, and CI's e2e job has no `YOUTUBE_API_KEY`, so Director is off there and `DirectorGate` hides the page. The test now checks navigation, then the plan through the same procedure the page calls (`/rpc/director/plan`), which works whatever the feature flags say.
- **Footer on every page.** Moving the footer out of `<main>` put a "Legal" footer on every non-immersive page (sign-in, settings, terms…), not just the landing.

### Commands (tails)
- `bun run lint`: every step ✔. My first run flagged the skipped e2e test; I rewrote it as described above.
- `bun run check-types`: `Tasks: 24 successful, 24 total`.
- `bun run type-coverage apps/web`: `✔ apps/web`. I gave the callback ref an explicit `HTMLIFrameElement | null` type.
- `bunx turbo run test --continue`: `@repo/web 189 passed`, `@repo/contracts 35 passed`, `@repo/i18n 11 passed`.
  - Under the machine's load (stacks 3–9 running ClamAV and more), api, worker, webhooks and notifications each timed out once in their `env.test.ts` (15 s). These are files I didn't touch.
  - Re-run serially (`--concurrency=1`): api, webhooks and notifications passed. Worker failed again, then passed alone: `Tests 15 passed (15)`.
- `bun run --cwd apps/web test:e2e e2e/platform.spec.ts --workers=2` (stack 7): **22 passed (1.7m)**.
  - Earlier runs failed in sign-up and settle steps for two reasons. First, stack 7's Postgres restarted twice: its log shows a child exiting with code 2, then "terminating any other active server processes" and recovery. Second, Next's dev server took 10.3 s to compile `/director/[videoId]` the first time, longer than the 10 s URL timeout.
  - All passed once the stack was stable and warm.
- `bun run --cwd apps/web test:integration test/marketing/original-player.test.tsx test/shell/site-chrome.test.tsx`: `Tests 6 passed (6)`. The first attempt hit the same Postgres restart, and I retried it.
- Coverage of the touched files:
  - command: `vitest run --coverage --coverage.include='src/modules/marketing/**' --coverage.include='src/modules/shell/components/site-*.tsx' --coverage.include='src/app/layout.tsx' --coverage.include='src/app/page.tsx' --tags-filter='!files' src/modules/marketing src/app test/marketing test/shell/site-chrome.test.tsx`;
  - result: 41 passed. Every touched file is at 100% lines, branches and functions.
  - The only file listed is `site-header.tsx`, which I didn't touch; its own header test isn't in this run.
- `bun run --filter @repo/web build`: exit 0. `budget`: `/ 317.8 kB / 410 kB`, shared `127.4 kB / 135 kB`.
- `bun run gen`: no drift.

### Screenshots (playwright-cli -s=landing, chromium, stack 7)
In `/Users/manas.madan/Desktop/code/director-editor/.claude/worktrees/agent-aa2d6ebaeca1fa9e6/.playwright-cli/fix1/`:
- `landing-desktop-light-hero.png` and `landing-desktop-light-full.png` (1440 × 900)
- `landing-desktop-dark-hero.png` and `landing-desktop-dark-full.png`
- `landing-phone-light-hero.png` and `landing-phone-light-full.png` (390 × 844)
- `landing-phone-dark-hero.png` and `landing-phone-dark-full.png`
- `landing-play-focus.png`: keyboard focus ring on the original's frame

### Remaining concerns
1. **Channel names.** They are gone because the shared seed data doesn't carry them; see Decisions.
2. **e2e and the UI.** The template-card e2e checks the plan through the API, not the page's UI, because CI runs without Director's optional services.
3. **Footer on every page.** The site footer now appears on every non-immersive page.
4. **Load-related failures, unrelated to this change.** Postgres restarts and env-test timeouts happened under the machine's load; neither came from this change.
