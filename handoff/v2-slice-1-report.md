# Director v2, slice 1: one safe shoot screen (report)

Branch `feat/mm/director-v2` (from `origin/master` ae43b93), pushed. Status: DONE, with the
notes under "Not proven here" and "Calls I made".

## What changed

**One screen, one mode.** `apps/web/src/modules/director/pages/shoot.tsx` is rewritten. The
screen is no longer keyed per shot: one `ShootScreen` lives for the whole short, so the
camera, the microphone and Director stay up from shot to shot (moving shots changes only
the query and what's shown). The camera opens on the selfie side (`useCamera` takes no
shot camera any more) and only on the "Start shooting" tap. The microphone choice is per
shoot (`audio === "voice"`), not per shot, so a photo shot doesn't reopen the camera.

Layout (phone first, full-bleed 9:16 column on laptop): top band = shot progress (or
"● REC 00:03" while recording), a Director pill (joining / here), Leave (✕), the shot card
(Where / Do / Say), and the honest notice when Director can't join; bottom band =
Director's captions (both sides, typed lines too), the "Tell Director…" text box, then
flip · shutter. During a take: REC pill, "Director's quiet while you film" chip, the
teleprompter (or the step), text box hidden. After a take: loop review with Director's
captions, Go again / Keep it.

**Live starts on "Start shooting".** The tap opens the camera and starts Director live
(also unlocking audio). The first time, the card explains that Director sees/hears while
you get set, that a take records only on the shutter, and that the browser will ask for
camera and microphone next (quality bar: no cold permission prompt). Later visits say
less (`lib/memory.ts` now only counts started shoots; old stored values are parsed and
trimmed). The button waits until `system.info` is known, so it never starts without Live
on a site that has it.

**Per-take baseline.** `hooks/use-studio.ts`: the shutter is the only way a take starts.
Tap → 3-2-1 → records until tapped again or shot length + 1.5 s. The countdown is
cancellable from the shutter (it becomes a ✕ "Cancel the countdown") or Escape
(`hooks/use-countdown.ts` gained `cancel`). Kept takes upload and move on; "Go again"
discards.

**Removals (6.2).** Deleted: the spoken command words and recogniser (`use-listening`,
`lib/intents`, `recognizer.d.ts`), the raised-hand trigger and pose/object detectors
(`use-body-guides`, `use-pose`, `use-things`, `lib/pose*`, `lib/object-detector`,
`lib/things`, `lib/framing`, `lib/readiness`), scene checks and doodles (`use-scene-guide`,
`lib/doodle`, `lib/sketch`, `lib/spring`, `doodle-layer`), the cue engine and canned lines
(`lib/cues`, `use-live-director`, `use-director-voice`, `lib/speech`, `live-caption`,
`director.live.say.*`), the stick buddy/stickers, tilt (`use-tilt`, `lib/tilt`), the
Director's Cut heuristics (`lib/cut`, `lib/frame-stats`, `directors-cut`), screen share,
mute, voice/listen toggles, countdown picker, the call button and both docks
(`live-dock`, `live-hud`, `live-stage`, `live-call`), and every "call"/"Director Live"
wording (`director.call.*` gone; landing copy and an error message reworded). The
editor's spoken canned wrap line is gone too (the card stays). With MediaPipe gone, I
removed the dependency and took jsDelivr, Google model storage and `wasm-unsafe-eval` out
of the CSP. No scene-check doodles are drawn at all (grounded marks are slice 11). No
scripted on-device loop exists as a mode.

**Director live (API).** `apps/api/src/modules/live/`:
- Tools are now `go_to_shot` (shot from 1) and `switch_camera` (`to`). Nothing Gemini can
  call starts or stops a take. Each call reaches the browser with an id; Gemini hears the
  real result only after the browser answers (`done`, `busy` with why, `no_camera`;
  `not_found` for a shot the plan hasn't; `unknown` after 5 s with no answer).
- New client messages `camera` (flip) and `take` (recording/recorded/discarded) become
  notes in the relay's own words ("[They flipped to the back camera. Look at the new view
  and say what you see, in one sentence.]", "stay completely silent", "speak first"),
  rate-limited to 10 per 10 s (dropped, not punished). The browser never writes what
  Gemini is told.
- **Sessions rotate silently**: the relay opens a fresh upstream after 9 min or on
  `goAway`, resumes from the latest `sessionResumptionUpdate` handle (or catches up with
  the last 8 lines when there is none), and lets the old one go only once the new one's
  setup completes. A shoot can run 30 min (was a 10-min call). The hourly allowance counts
  browser connections, not rotations.
- `&resume=1` on the browser's URL opens with "don't greet again, wait for them" instead
  of a hello (used by the silent retry and by remounts).
- Gemini's `turnComplete` is passed on as `{type:"turn"}` so each Director turn starts a
  new caption line.
- Persona rewritten to the friend in 6.15, adapted for per-take: never starts or stops a
  take, tells the member to tap the shutter, silent during takes, speaks first after,
  the plan is a starting point, never corrects a same-meaning rewording, banned words.
- Typed turns allowed: 6 per 10 s (was 3; the acceptance types 5 lines in a row).
- `system.info` reports `live` (`features.live = Boolean(GOOGLE_CLOUD_PROJECT)`).
- `LIVE_API_URL` (test hook; must be `wss://` in production) in `env.ts`, `.env.example`
  and `docs/environment.md`.

**Browser side.** `lib/live-session.ts` (was call-session) and
`hooks/use-director-live.ts` (was use-live-call): mic refused or lost → Director goes
deaf (notice; typing still works), not away; a flip sends a fresh frame of the new
camera, then the `camera` note; one silent retry after 2 s on dropped /
UPSTREAM_UNAVAILABLE / INTERNAL, then the honest notice with the reason, "You can still
film: tap the shutter for each take." and Try again (none when the site has Live off).

**Mock Google Live stand-in** (spec 16.3): `packages/fake-google/src/live.ts`, a
WebSocket at Vertex's path that checks the bearer token, wants `setup` first, hands out
resumption handles, answers notes and turns with scripted lines and silent audio, calls
`go_to_shot` / `switch_camera` on cues ("go to shot 2", "switch to the back camera"), and
can `goAway()`. The web tests' `full` API now runs with `GOOGLE_CLOUD_PROJECT` +
`LIVE_API_URL` pointing at it; the `bare` variant keeps it off. Vite's test proxy passes
WebSocket upgrades (`ws: true`). New browser commands `liveTurns` / `liveSessionCount`
read what the stand-in was told.

## Acceptance checks

| Check | How it's proven |
|---|---|
| "okay let me go to the kitchen", "go", "ready", "let's go", "start": nothing starts | `apps/web/test/director/shoot.test.tsx` "never starts a take from anything said": each line goes through the real relay to the mock Live API, which answers; the shutter stays "Record a take", no REC, no take note sent; no speech recogniser is ever constructed. There is no listener left in the code. Evidence `03-said-go-nothing-started.png`. |
| Raise both hands, walk out of frame: nothing starts | No pose/hand/object detection or framing/timer auto-start exists any more (files deleted, MediaPipe removed, the CSP no longer allows its loader). Only `useStudio().actions.shutter` starts a take. Absence is the proof here; the owner's UAT step 4 confirms it on a phone. |
| The only controls are flip, the shutter, the text box | Same file, "puts only flip, the shutter and the text box in the member's hands": the buttons on screen are exactly Send, Flip the camera, Record a take, plus the textbox (and the ✕ link out, see "Calls I made" 1). Evidence `02` to `08`. |
| Flip mid-conversation: Director comments on the new view | Same file, "tells Director about a flip…": the back camera opens, the relay sends the flip note, the stand-in answers and it's captioned. Real Gemini gets "[They flipped to the back camera. Look at the new view and say what you see, in one sentence.]" right after a frame of the new camera (`director-live.test.tsx` checks the order). Evidence `04-flipped-director-comments.png`. |
| Ten shots past ten minutes: no "call ended" | API `live.test.ts`, "moving to a fresh connection to Gemini": resumes from the handle before the old connection goes, unnoticed; `goAway` triggers it; catch-up without a handle; old connection closing first waits for the new; shot moved meanwhile; a tool answer for a retired connection is dropped; "ends after half an hour, however many connections". Browser: moving shots keeps one socket and no camera reopen (`shoot.test.tsx`), a dropped line is retried silently with `resume=1` (`director-live.test.tsx`). Not run for a real ten minutes here. |
| Camera and Live stay up across shots / no black flash | `shoot.test.tsx` asserts no extra `getUserMedia` and one Live session across a move (and across a kept take in the `files`-tagged test, left to CI). Evidence `08-next-shot-same-camera.png`. |
| `live` added to `system.info` | `env.test.ts`, `features-off.integration.test.ts` (live false), client fixtures; `openapi.json` regenerated. |
| Per-take baseline: shutter + cancellable 3-2-1 | `use-studio.test.tsx` "calls the countdown off from the shutter or Escape, and never records then"; `shoot.test.tsx` countdown test. Evidence `05`, `06`, `07`. |
| Honest notice when Live can't start, baseline kept | `shoot.test.tsx` "when Director can't join" (Live off: reason, "You can still film…", no Try again, no text box, shutter enabled); `director-live.test.tsx` silent retry then reason + Try again, per-code messages, deaf without a mic. Evidence `09-director-unavailable.png`. |

## Evidence

Phone size (390×844), headless Chromium, canvas fake camera, real API and relay, mock
Live API, in
`/Users/manas.madan/Desktop/code/director-editor/.superpowers/sdd/2026-10-18-director-hackathon/v2-evidence/`:
`01-start-card`, `02-director-live`, `03-said-go-nothing-started`,
`04-flipped-director-comments`, `05-countdown-cancellable`, `06-recording`,
`07-take-review`, `08-next-shot-same-camera`, `09-director-unavailable` (.png). The
captions are the stand-in's scripted lines, not Gemini's. Captured with a throwaway test
file that isn't committed.

## Commits (feat/mm/director-v2)

```
6f4b2a9 docs(docs): add Director's UX redesign spec and UAT guide
966d296 feat(api): keep Director live through the whole shoot, with tools that can't start a take
17ee6af feat(web): one shoot screen, with Director live from Start shooting and the shutter as the only way to take
964f23a test(web): run the shoot screen against the mock Live API, and drop what the pose model needed
5d92857 docs(docs): describe the one shoot screen and Director live as they work now
77894d1 test(web): cover the shoot screen's memory and wake lock hooks on their own
4c1549d test(client): give the system info fixtures the live feature
```

## Tests run here

- `bun run lint`: pass (biome, knip, boundaries, markers, patterns, actionlint and the rest).
- `bun run check-types`: pass (after giving the client package's fixtures the `live` flag).
- `bun run test`: everything passes except two `apps/worker` tests that timed out at 15 s
  while the whole monorepo ran in parallel; the worker is untouched, and
  `bun run --filter @repo/worker test` alone passes (15/15).
- `bun test ./scripts/`: 793 pass, 2 fail in `scripts/pre-push.test.ts`, which expect the
  default stack's Postgres port (55432) and get stack 5's (55932) from this worktree's
  `.env`; unrelated to the change, and they pass on a default stack.
- API live + env unit tests: 80 pass, 100% lines/branches/functions on
  `src/modules/live/**`, `env.ts`, `features.ts`.
- `packages/fake-google` 26 pass (100% coverage), `packages/contracts` 54,
  `packages/client` 86, `packages/i18n` 11, `apps/web` unit 124.
- Browser files on my own stack 5, one file at a time, `!files` tag: `shoot.test.tsx`
  13 pass (4 `files`-tagged left to CI), `director-live.test.tsx` all pass,
  `use-studio.test.tsx` 8, `use-camera.test.tsx` 6, `shoot-hooks.test.tsx` +
  `use-countdown.test.tsx` 6, `edit.test.tsx` 5 (12 `files`-tagged left to CI).
- `bun run gen`: `openapi.json` regenerated (adds `live`), committed; no other drift.
- Not run locally, per the machine constraint: the whole browser suite, the `files`
  profile, merged coverage, e2e. CI runs them.

## Calls I made where the spec is silent or doesn't fit slice 1

1. **A ✕ "Leave the shoot" link stays** in the top band. Slice 1's acceptance says the
   only controls are flip, shutter and text box, but 6.1's own wireframe has ✕ there, and
   a shoot screen with no way out on a laptop is worse. It's navigation, not a camera
   control; easy to drop if the review disagrees.
2. **The intro card is honest for per-take**, not 6.3's "records the whole time" copy
   (that's slice 3): it says a take records only on the shutter.
3. **No "Slower line" pill yet**: that line is slice 6, so the notice says why Director
   can't join and that the shutter still works, with Try again (not on a site with Live
   off, where it can't help).
4. **Only two tools** (`go_to_shot`, `switch_camera`), neither able to start a take. The
   rest of 6.6 belongs to later slices; `pause` doesn't apply without continuous
   recording.
5. **Rotation at 9 min with session resumption**, catch-up text without a handle, and a
   30-minute cap per shoot (was 10 per call).
6. **Typed turns 6 per 10 s** (was 3): a fast typist's burst, and the acceptance types 5.
7. **Each Director turn is its own caption line** (the relay passes `turnComplete` on);
   without it, two turns merged into one caption.
8. **The take review's captions are off by default**: the native caption track sat under
   the buttons, and the plan's line isn't always what was said. Still there to turn on.
9. **The editor's canned spoken wrap line is removed** (principle 2: every word is
   Gemini's); the visual wrap card stays. `director.speak` and its TTS stay on the API
   for slice 6.
10. **Scene checks still exist server-side** (`director.checkScene`, the AI agent, its
    limits and their docs in architecture/auth) but the web no longer calls them.
    Removing the procedure is an `/api/v1` change, left for a cleanup slice.
11. The shoot screen's frosted glass is darker (55% → 72%) so white captions keep their
    contrast over a bright camera picture (seen in the evidence).

## Not proven here (for the review and UAT)

- Real Gemini: the persona's tone, that it really comments on a flip in its own words,
  first-word latency (2.5 s target), and the 9-minute rotation against Vertex's real
  `goAway`/resumption (built to the Live API's documented messages; tested only against
  stand-ins).
- iPhone Safari: two microphone captures at once (the camera's, for voice takes, and
  Director's own). The old call mode did the same; worth watching in UAT.
- Raised hands and walking out of frame: absence of the code is the proof.

## Anything the spec got wrong

- Slice 1's "the only controls are flip, the shutter, the text box" conflicts with 6.1's
  wireframe (✕, pause, Shots, Done). For slice 1 I kept only ✕.
- 6.3's consent copy assumes continuous recording, which slice 1 doesn't have yet.
- 6.7's "the per-hour limit counts shoots, not reconnects" holds for the relay's
  rotations, but the browser's one silent retry after a drop is a new connection and
  does count; at one per drop it's negligible against 20 an hour.

## Where things stand

Done and pushed. Stack 5 was stopped with `bun run db:down`.

---

# Review round 1 (after the product review)

Rebased `feat/mm/director-v2` onto `origin/master` fd9ef09 (#13). The two conflicts were
in `live.relay.ts` and `live.test.ts`: I kept both sides. Master's `CallEnd` and
`startedAt` (for its activity lines) now ride on my rotating relay: `run()` resolves with
`{ code, startedAt }`, and `startedAt` is set when the first setup completes. Master's
activity tests use `MAX_LIVE_MS`. `bun run gen` gives no drift. Every commit was rebased
and authored as Manas Madan. Force-pushed.

## Fixes

- **Major 1, leaving:** `hooks/use-leave-guard.ts`. In setup, ✕ leaves at once. During a
  countdown, a recording or with a take not kept yet, ✕ and the browser's back both ask
  first. The dialog says "Leave?" / "This take isn't kept yet." with Leave and Stay. The
  count is called off or the recording stopped first (`studio.actions.halt`), so the
  take waits behind the question, and Stay keeps it on review. Back is caught with an
  extra history entry for the same page while it's guarded. The entry is taken off when
  the take is settled, and replaced (not stacked) when a kept take moves on. Tests are in
  `shoot.test.tsx`, "leaving the shoot" (three cases, including back) and
  `use-studio.test.tsx` "halts a take…". Evidence `07-leave-asks-first.png`.
- **Major 2, caption order:** `lib/live.ts` now keeps the last exchange as lines, oldest
  first, so a reply sits under what it answers and the older line is dimmed. Director's
  `turn` finishes its line. The member's line goes 8 s after Director's finished answer,
  and at once on a flip, a countdown or a take review. The visual lines are hidden from
  screen readers. One live region reads each finished line once ("Director says …" /
  "You said …", ICU arguments), not word by word. Tests are in `lib/live.test.ts` and
  `director-live.test.tsx` (order, typed lines, flip and 8 s clearing). Evidence `03`,
  `04`, `08`.

## Minors

1. **Talking over the 3-2-1, and held words shown later:** there are new take states
   `countdown` and `cancelled` (contract and relay notes: "Go quiet now…", "no take this
   time"). Director's voice is held from the first number. Director transcripts that
   arrive while held are dropped. Tested in the API live tests and in
   `director-live.test.tsx`.
2. **Text box on the take review:** done, above Go again / Keep it. Tested in
   `shoot.test.tsx`. Evidence `08`.
3. **"Start shooting" twice:** the template page's button now says "Let's shoot".
   `director.test.tsx` and `docs/director.md` are updated.
4. **Unavailable copy:** it now says "Director isn't available right now."
5. **Stop shutter:** it really was round. The record circle used a 9999px radius, so the
   morph stayed round until its last frame. Both shapes now have pixel radii, and the
   square shows as recording starts (evidence `06-recording-stop-square.png`).
6. **Shot progress contrast:** the dashes now sit on the glass pill.
7 to 9. **No change, as the review agreed:** the pill word waits for slice 2, the upload
   wait goes with slice 3, and the scene-check procedure goes in slice 16.

The updated spec from the main checkout is committed (`336ac42`).

## Checks run

- `bun run lint`: pass. `bun run check-types`: pass. `bun run test`: 22/22 tasks pass.
- API live tests: 69 pass, 100% lines and branches on `src/modules/live/**`. Contracts:
  57 pass.
- Browser files on stack 5, run one at a time (not the broad suite):
  - `shoot.test.tsx` + `director-live.test.tsx` + `use-studio.test.tsx`: 43 pass, 4
    `files`-tagged skipped.
  - `director.test.tsx`: 22 pass.
- `bun run gen`: no drift. Stack 5 is stopped.

## Evidence

Refreshed in `v2-evidence/`: `01-start-card`, `02-director-live`,
`03-said-go-nothing-started-captions-in-order`, `04-flipped-director-comments`,
`05-countdown-cancellable`, `06-recording-stop-square`, `07-leave-asks-first`,
`08-take-review-with-text-box`, `09-next-shot-same-camera`, `10-director-unavailable`.

## Commits in this round

```
336ac42 docs(docs): update the redesign spec with slice 1's review rulings
0fdb12a fix(api): tell Director when the 3-2-1 starts or is called off, so it goes quiet from the first number
a671637 fix(web): ask before leaving an unkept take, and read the captions in order
3d511cf fix(web): make the shutter's stop a square you can see as it turns
655a6f4 docs(docs): describe leaving a take, the captions' order and the quiet 3-2-1
```

## Worth knowing

- The back guard relies on Next merging its own state into `history.pushState` (its
  documented native History API support). Real back gestures in the app router aren't
  covered by the test router, so check this on a phone in UAT step 9.
