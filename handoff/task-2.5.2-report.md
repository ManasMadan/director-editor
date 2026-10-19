# Task 2.5.2 report: the Gemini video call screen

Status: DONE_WITH_CONCERNS (the concerns are follow-ups outside this task's files, listed at the end)

Branch: `worktree-agent-ac68c9318c2d758b3` (reset onto `origin/feat/mm/director-hackathon` at 1ea8e58)
Commit range: `1ea8e58..084cebb` (one commit: `feat(web): call Director over a live video call from the camera screen`)

(The worktree guard refused the shared-checkout report path, so this report is at the same
relative path inside the worktree, uncommitted.)

## What changed and why

### New files (apps/web/src/modules/director)

- `lib/pcm.ts` (+ `pcm.test.ts`, unit): the audio formats. `downsampler(fromRate)` brings the
  mic's native rate (44.1 or 48 kHz) down to 16 kHz with a box filter. Its window bounds count
  from the start of the stream, so chunks of any size give exactly the samples the whole would.
  Also `toPcm16`/`fromPcm16` (clipped), `encodePcm16`/`decodePcm16` (little-endian base64; a
  stray odd byte is dropped) and `levelOf` (RMS to 0..1, for the orb). `CAPTURE_RATE` is 16 000
  and `PLAYBACK_RATE` 24 000.
- `lib/live-call.ts` (+ `live-call.test.ts`, unit): the client side of the protocol.
  - A zod schema for every server message: `audio`, `transcript`, `tool` (the five tool names),
    `interrupted`, and `error` with `errorCode.catch("INTERNAL")`, so a code newer than the page
    still counts as a failure.
  - `parseServerMessage` ignores anything it can't read, the same way the relay ignores what it
    can't read from Gemini.
  - `callUrl` builds the ws/wss URL on the page's own origin: `/api/live?videoId&shot`.
  - `withTranscript` builds captions from the transcript fragments. Words from the same speaker
    continue their line, a new speaker starts one, and long lines keep their last words.
- `lib/call-audio.ts`: the browser audio.
  - One shared `AudioContext`, made or resumed by the tap that starts the first call. It's
    reused so the next shot's call, which starts by itself, may play sound too.
    `restCallAudio` suspends it when the shoot page unmounts.
  - The capture AudioWorklet is a source string loaded from a `blob:` URL. It runs in the audio
    thread's own scope and can't be bundled, and a file in public/ would also be a tracked source
    with no coverage for `scripts/coverage.ts`. It posts chunks of about 100 ms; the main thread
    downsamples and converts them.
  - `openMicrophone` asks for echo-cancelled, noise-suppressed audio. It reports a track that
    ends by itself (unplugged, permission revoked), and turns the mic off again if the stream
    can't be used.
  - `createPlayer` queues 24 kHz `AudioBuffer`s back to back on the context clock. `flush()`
    stops everything queued (barge-in), and an `AnalyserNode` gives the level.
- `lib/call-session.ts`: one call's lifecycle outside React (`startCall`).
  - It opens the mic first, then the socket, so a refused mic never spends one of the api's 20
    calls an hour.
  - Mic chunks and a frame a second (640 px JPEG via the existing `captureFrame`) start only
    once the socket is open.
  - It hands messages on, and lets everything go exactly once, however the call ends.
  - A close after an `error` message fails the call with that code; a close without one fails it
    as `"dropped"`.
- `hooks/use-live-call.ts`: `useLiveCall({videoId, shotIndex, video, onTool, onEnd})` returns
  `{state: "idle"|"connecting"|"live"|"ended"|"failed", start, end, muted, toggleMute, speaking,
  captions, level}`. That's the brief's interface plus what the UI needs. `onEnd(failure|null)`
  fires on hang-up or failure, never on unmount; leaving the screen hangs up quietly.
- `components/live-call.tsx`:
  - `CallOrb`: an aurora orb scaled by the voice level, written straight onto a CSS variable
    every frame; it holds still under reduced motion.
  - `CallPill`: GeminiLoader + "Calling Director…" while ringing, orb + "On a call" once live.
  - `CallCaptions`: Director's line with its orb and the member's line as a bubble, with
    screen-reader prefixes "Director says" and "You said".
  - `CallButton`, and `CallDock` (mute, the shutter, hang up).
  - `useCallFailure`: turns a failure into its translated message; unknown codes read "The call
    stopped unexpectedly."

### Changed files

- `pages/shoot.tsx`:
  - `Shoot` holds `calling` above the per-shot `Studio` (which is keyed by shot), so a call
    carries on to the next shot. Next keeps the page mounted when only the query changes
    (`createRouterCacheKey(segment, true)` drops search params from the layout router's key),
    and the new `Studio` starts the next shot's call by itself.
  - `useCall` maps Director's tools onto the session's existing spoken-request handlers:
    - `start_recording` -> action (setup only, through the existing countdown)
    - `stop_recording` -> cut (recording only)
    - `retake` -> again (review only)
    - `next_shot` -> keep the take on screen (upload, then the existing navigation), or skip to
      the next shot if there's no take yet
    - `previous_shot` -> the previous shot (not from the first)
  - On a call the viewport takes the full height (edge to edge on a phone), with the header and
    dock floating over it. The existing guides, ready check, countdown, teleprompter and
    Director's Cut stay.
  - On a failure, `onEnd` shows `toast.error(reason, {description: fallback})` and sets
    `calling` to false. The toast sits at the top because at the foot it covered the shutter
    (the tests caught that). Director Live then picks up the same shot in the same `Studio`, so
    the take on screen and the takes already sent are untouched.
  - The plan-loading spinner is now a `GeminiLoader`.
- `hooks/use-session.ts`: now `useSession(props, calling)`. On a call, the on-device voice
  (speech synthesis) and ears (speech recognition) stay quiet, and the Gemini scene checks stop:
  Gemini sees the frames itself, and each check would spend allowance. It also returns
  `requests` (the spoken-request handlers) for the call's tools.
- `hooks/use-studio.ts`: exports `nextPage` and a new `shotPage(videoId, index, audio)`.
- `components/live-dock.tsx`: adds the Call Director button (required `onCall`), first in the dock.
- `components/live-stage.tsx`: `LiveViewport` takes `full` (whole height on a call).
- `lib/media.ts`: `base64OfBytes` is split out of `base64Of` and shared with the PCM encoder.
- `packages/i18n/messages/en.json` (+ the generated `en.d.json.ts`) adds `director.call.*`:
  start, connecting, live, controls, mute/unmute, end, you/director, fallback, and
  `failed.{microphone, dropped, RATE_LIMITED, TIMEOUT, CONFLICT, FEATURE_DISABLED,
  UPSTREAM_UNAVAILABLE, DIRECTOR_PLAN_NOT_FOUND, DIRECTOR_SHOT_NOT_FOUND, UNAUTHENTICATED, other}`.
  Those cover every code the relay sends (`live.gateway.ts`, `live.relay.ts`). Any other code
  (INTERNAL, VALIDATION_FAILED, NO_ACTIVE_ORGANIZATION, ...) reads "The call stopped
  unexpectedly."
- `apps/web/test/director/camera-parts.test.tsx`: the dock test also presses Call Director.

### Tests

`apps/web/test/director/live-call.test.tsx` runs in Chromium against the real API. The socket is
a stand-in (`vi.stubGlobal("WebSocket", FakeSocket)`), the camera is a canvas and the mic an
oscillator; the AudioContext, the worklet and the recorder are real. It covers:

- **Starting a call**: the ringing state (GeminiLoader), the socket URL, the mic constraints, and
  the on-device ears stopping.
- **What goes up**: mic chunks are about 100 ms of 16 kHz PCM (3000-3300 bytes), and frames are
  JPEGs.
- **Director's voice and captions**: the voice plays (the viewport glow comes on, then goes off
  once it has played out), and both sides are captioned.
- **Mute and hang-up**: mute toggles the track. Hanging up closes the socket and stops the mic;
  Director Live then listens again, and the on-device voice said nothing during the call.
- **Tools**: record, stop and retake work. `next_shot` mid-take and `previous_shot` from the
  first shot are ignored. `next_shot` before a take skips ahead and the next shot's call starts
  by itself; `previous_shot` goes back (a third call).
- **Barge-in**: `interrupted` stops playback, and unreadable messages are ignored.
- **[RF 4]** fallbacks:
  - mic refused: toast + fallback text, no socket, same URL
  - relay error mid-call with a take in review (`UPSTREAM_UNAVAILABLE`): toast, and the
    Director's Cut and Keep it are still there, on the same shot
  - line dropped, INTERNAL and RATE_LIMITED: each shows its message, and calling again works
    after each
  - mic track ended mid-call
- **The hook on its own**:
  - end, mute and level before there's a call
  - hanging up while the mic prompt is still open: the late stream is stopped, and no socket
    opens
  - a stream with no audio fails the call as "microphone", and the stream is stopped
  - unmount hangs up without `onEnd`
  - a frame the camera can't give is skipped
- **The orb** holds still under reduced motion.
- **Files suite** (`tags: ["files"]`): `next_shot` on a take in review uploads it, and the next
  shot's call starts.

Unit tests: `lib/pcm.test.ts` (9) and `lib/live-call.test.ts` (6).

There's no Playwright e2e of the call (real Vertex isn't reachable in CI), as instructed.

## TDD evidence

I wrote the unit tests first and ran them before the modules existed:

    $ bun run --cwd apps/web vitest run --project unit src/modules/director/lib/pcm.test.ts src/modules/director/lib/live-call.test.ts
     Test Files  2 failed (2)
          Tests  no tests
    (both fail to import ./pcm and ./live-call)

They passed (15/15) once `pcm.ts` and `live-call.ts` existed.

The component test was not test-first: I wrote it after the first version of the hook and the
page. Its first run failed 4 of 12, and each failure was a real finding:

- the caption assertions targeted the wrong text node
- the error toast blocked taps on the dock (the toast moved to the top)
- the test route didn't pass the shot from the query the way Next does
- one upload test belonged in the files suite

Writing the hook tests also turned up a real leak in the mic path: a stream the call couldn't
use stayed on. The "no sound" test pins the fix.

## Commands and output tails

    $ bun run lint
      ✔ bunx biome check .   ✔ lint:boundaries   ✔ lint:unused   ✔ lint:markers   ✔ lint:patterns
      ✔ lint:suppressions    ✔ lint:prisma ... ✔ bunx turbo run lint
    lint exit 0

    $ bun run check-types
     Tasks:    24 successful, 24 total
    types exit 0

    $ bun run test
     Tasks:    22 successful, 22 total
    @repo/web:test:  Test Files  36 passed (36)
    @repo/web:test:       Tests  180 passed (180)

    $ bun run --cwd apps/web test:integration test/director/live-call.test.tsx
     Test Files  1 passed (1)
          Tests  12 passed | 1 skipped (13)

    $ bun run --cwd apps/web test:integration:files test/director/live-call.test.tsx
     Test Files  1 passed (1)
          Tests  1 passed | 12 skipped (13)

    $ bun run --cwd apps/web test:integration test/director/shoot.test.tsx test/director/director.test.tsx test/director/review.test.tsx
     Test Files  3 passed (3)
          Tests  30 passed | 8 skipped (38)

An earlier run of all of test/director, with `bun run lint` running alongside, had 11 failures in
the director, review and shoot tests. Every one was "/sign-up/email answered 500" from the test
API under load. Run alone they pass, and the full coverage run below passes them too.

    $ bun run --filter @repo/web coverage && bun scripts/coverage.ts apps/web/src/modules/director
    @repo/web coverage:  Test Files  89 passed (89)
    @repo/web coverage:       Tests  516 passed (516)
    71 source files, 1 reports: 0 below 100%.

    $ bun run gen
     Cached:    6 cached, 6 total   (no drift; en.d.json.ts regenerated and committed)

    $ bun run type-coverage apps/web
    packages/i18n/src/index.ts:51:1: Unused ignore line directive(no problems reported on that line)
    (31296 / 31297) 99.99%

That type-coverage failure isn't from this change: HEAD's en.json gives the same result, and the
file it names is one I didn't touch. My new source files have no `any` and no casts.

I didn't run `bun run test:integration` for all packages: I touched only apps/web and the i18n
catalog, and the whole web suite ran under coverage (516 tests). I ran
`bun scripts/services.ts up --files` to start the files profile's `s3-init` for the upload test;
rustfs and clamav were already up.

## Decisions the brief didn't make

- **WebSocket in `bun dev`**: Next 16.3.8 proxies WebSocket upgrades for external rewrites
  (`router-server.js` `upgradeHandler` -> `proxyRequest(..., head)` with `ws: true`), and
  `proxy.ts`'s matcher already skips `/api`. So the browser connects to `/api/live` on its own
  origin, like `/rpc`. No api URL is exposed to the browser and nothing is hard-coded.
- **CSP**: I checked the app's exact policy (nonce + `'strict-dynamic'`, `connect-src 'self'`)
  in Chromium with a scratch page. An AudioWorklet from a `blob:` URL and a `ws:` connection to
  the same host both load, so no CSP change was needed. Safari and Firefox weren't available to
  check.
- **Mute** disables the mic track rather than stopping sends: silence keeps flowing, so Gemini's
  voice activity detection still sees speech end. The button is enabled only once the call is
  live.
- **Barge-in** follows the relay's `interrupted` message (Gemini's own voice activity detection,
  with `START_OF_ACTIVITY_INTERRUPTS`) rather than a local level threshold, which the speaker's
  echo would trip.
- **Failure copy** is one key per reason, not one ICU `select`: a select with 11 branches pushes
  next-intl's message-key type past TypeScript's instantiation depth (TS2589 in
  `apps/web/src/lib/metadata.ts`).
- **Toast position** for call failures is `top-center`, so it never covers the shutter.

## Concerns / follow-ups (outside this task's files)

1. **The message shapes now exist twice**: the api's `apps/api/src/modules/live/live.messages.ts`
   (TS types + zod for the client's messages) and the web's
   `apps/web/src/modules/director/lib/live-call.ts` (zod for the server's). They belong in
   `packages/contracts` as one schema for both, tool names included. I didn't move them because
   another agent was editing the contracts package and the brief kept me to the web side.
2. **Director's voice can end up in a voice take**: a take recorded with the member's voice
   (`audio=voice`) can pick up Director from the speaker if Director talks while it records. The
   recorder's track also asks for echo cancellation, but nothing stops the model talking
   mid-take. Options: tell the model in the relay's persona to stay quiet between
   `start_recording` and `stop_recording`, or lower playback while a voice take records.
3. **Every shot is its own call**: the relay builds the system instruction for one shot, so a
   6-shot short spends at least 6 of the 20 calls an hour the api allows.
4. **Production routing** of the `/api/live` upgrade through the gateway on the VM is for the
   relay task or deploy to confirm. The web side assumes `/api/*` reaches the api for upgrades
   the way it does for HTTP.
5. **Already failing before this change**: `bun run type-coverage apps/web` fails on the unused
   ignore directive in `packages/i18n/src/index.ts:51`.

---

# Fix round 1

Status: DONE_WITH_CONCERNS (all 12 items done; the concerns are failures that were already
there, listed at the end)

Before starting I rebased the branch onto `origin/feat/mm/director-hackathon` at 5ee9744.
The round-0 commit is now `f772aa6` (it was `084cebb`), and the rebase also brought in the
i18n cast fix that cleared the old type-coverage warning. I ran the checks on my own service
stack (`bun run setup --stack 7`) and stopped it at the end with `bun run db:down`.

Commits of this round: `f772aa6..24a0958`
- `5db862b feat(contracts,api): carry one live call through the whole short`
- `24a0958 fix(web): keep the call going across shots and safe around takes`

Whole task: `5ee9744..24a0958`.

## Items -> change -> test

Line numbers are at 24a0958.

1. **Strict Mode / Fast Refresh dead call.**
   - Change: `apps/web/src/modules/director/hooks/use-live-call.ts:16-33` (`useCallLifetime`).
     On teardown it leaves the call, clears `call.current` and resets the state to `idle`.
   - Change: `use-live-call.ts:108-112`. `end()` on a call that is already over (or missing)
     still puts the hook back to `ended` and calls `onEnd(null)`.
   - Change: `pages/shoot.tsx:371-375`. The screen calls again by itself when `calling` is
     still true and the hook is idle.
   - Tests: `apps/web/test/director/live-call.test.tsx:525` (hook) and `:352` (page),
     "calls again by itself when the screen is remounted mid-call".
   - How the tests remount: the hook test wraps the probe in `<StrictMode>`, but in the vitest
     browser runner Strict Mode's second effect pass never ran (I logged it: the effect ran
     once). Both tests therefore hide and show a React 19 `<Activity>`. That tears effects down
     and sets them up again with state kept, which is what Strict Mode's second mount and Fast
     Refresh do to a screen. On the old hook the reshown screen never reconnects.
   - The "hanging up just resets" case is pinned at `:512`.
2. **`previous_shot` in any phase.**
   - Change: `shoot.tsx:411-415`. It only acts in `setup`, like `next_shot`.
   - Test: `live-call.test.tsx:269` sends `previous_shot` while recording and while reviewing.
     The URL stays put and the take survives.
3. **Review and recording hid the call's controls and captions.**
   - Change: `shoot.tsx:519-532`. On a call the dock stays; only the shutter is hidden in review.
   - Change: `components/directors-cut.tsx`, new `captions`/`raised` props (captions above the
     panel, the panel clear of the floating dock).
   - Change: `shoot.tsx:91` (`OnCallCaptions`), used over the recording foot (`:152`) and the
     review (`:264`).
   - Test: `:269`. Captions are visible while recording and in review; "End the call" and
     mute are visible in review; "Record" is absent.
4. **Director's voice in a voice take.**
   - Client:
     - `lib/call-audio.ts:166`: while held, `play` drops chunks.
     - `call-audio.ts:192-197`: `hold(on)` flushes what's queued.
     - `lib/call-session.ts:156`: a call starts held if a voice take is recording.
     - `call-session.ts:195`: the session exposes `hold`.
     - `use-live-call.ts:121`: the hook's `hold`.
     - `shoot.tsx:433-434`: holds while `phase === "recording" && micOn`.
   - Relay: persona line `apps/api/src/modules/live/live.setup.ts:34`, "Stay silent from
     start_recording until stop_recording: …".
   - Tests:
     - web `:332`: voice playing stops when the take starts, nothing plays during it, and it
       plays again in review.
     - api `live.test.ts:255`: the system instruction contains the line.
5. **Worklet kept running.**
   - Change: `call-audio.ts:25-28,40`. The processor returns `false` once told to stop.
   - Change: `call-audio.ts:130`. `stop()` posts `"stop"`.
   - Test: `:622` (`MessagePort.prototype.postMessage` called with `"stop"` on hang-up).
6. **Mute reset per shot.**
   - Change: moot under item 12. The single call and its `muted` state now live in
     `useShootCall` (`shoot.tsx:346`), above the per-shot screen.
   - Test: `:269`. Mute on shot 1, move to shot 2: still "Unmute" and pressed, and the mic
     track is still disabled.
7. **Duplicate tools.**
   - Change: `shoot.tsx:417-425`. Each render registers a fresh handler that ignores a repeat
     of the same tool until the next render. Re-arming on every render, rather than on a phase
     change, means a tool that did nothing (say, `start_recording` while sharing the screen)
     can still be asked for again later.
   - Tests:
     - `:269`: two `retake`s in a row give "Take 2", not "Take 3".
     - files suite `:476`: two `next_shot`s give one upload and one `addTake`.
8. **CONFLICT on the auto-started next call.** Moot: there is no next call any more (item 12).
9. **Accessibility.**
   - Focus: `useDockFocus` (`shoot.tsx:492-503`) moves focus to "End the call" when the call
     rings and to "Call Director" when it ends or fails. It doesn't move on first load or when
     a shot's screen opens mid-call. `CallButton`/`CallDock` take refs (`live-call.tsx:148,206`).
   - Announcements: `CallPill` (`live-call.tsx:85-101`) is one `aria-live` region. The
     ringing's visible text is `aria-hidden`, so only the loader's status says it, and
     reaching Director ("On a call") is announced.
   - Tests:
     - `:197`: focus goes to End, then to Call Director after hang-up; the visible "Calling
       Director…" is aria-hidden; "On a call" sits in an aria-live region.
     - `:394`: focus returns to Call Director after a failure.
10. **Error copy.**
    - Fallback: `live-call.tsx:20-39`. Codes with call-specific words use them; any other code
      goes through `useApiErrorMessage()({ code })`, which is `errors.<CODE>`. "Stopped
      unexpectedly" (`failed.other`) is gone.
    - New code: `DIRECTOR_CALL_TOO_FAST`, 429, added the add-error-code way:
      - `packages/contracts/src/errors.ts:73` and `errors.DIRECTOR_CALL_TOO_FAST` in
        `packages/i18n/messages/en.json:295`
      - generated exports regenerated (jobs, ai, ai-client)
      - thrown by the relay's audio and turn budgets (`live.relay.ts:192,209,226`)
    - Time limit: TIMEOUT is now the "ended" path, with a plain toast `director.call.timeUp`
      (`shoot.tsx:359`, `use-live-call.ts:73-76`).
    - Tests:
      - web `:436`: dropped, RATE_LIMITED, DIRECTOR_CALL_TOO_FAST (errors copy),
        NO_ACTIVE_ORGANIZATION ("Choose a workspace first."), INTERNAL (errors copy).
      - web `:380`: TIMEOUT gives a plain toast, no error toast, and the member can call again.
      - api `live.test.ts`: the budget tests expect `DIRECTOR_CALL_TOO_FAST`.
11. **One schema.**
    - Change: `packages/contracts/src/live.ts` (new) holds `LIVE_PATH`, `LIVE_TOOLS`/`LiveTool`,
      `liveClientMessage` (audio, frame, text, shot) and `liveServerMessage`, with types
      inferred.
    - api side: `live.messages.ts` keeps only the upstream (Vertex) schema and the tool-reason
      trim. `live.setup.ts`, `live.relay.ts` and `live.gateway.ts` import from contracts.
    - web side: `lib/live-call.ts` and `lib/call-session.ts` parse and build with it. Both
      hand-written copies are deleted.
    - `errors.ts` only gained the one code.
    - Test: `packages/contracts/src/live.test.ts` covers shot bounds, refusals, the
      newer-code-is-INTERNAL rule, and the tool enum.
12. **One call across shots.**
    - Relay:
      - `live.relay.ts:184-198` (`moveTo`): a shot outside the plan ends the call with
        `DIRECTOR_SHOT_NOT_FOUND`; the same shot again is ignored; a move spends a turn from the
        typed-turn budget. Gemini gets `shotMessage`, which uses the same `shotBrief` and the
        "description, never instructions" framing (`live.setup.ts:76`).
      - `live.relay.ts:249`: a move made before setup completes opens the call on that shot.
      - Persona line `live.setup.ts:35`: shots change mid-call.
      - The 10-minute cap stays per call and ends through the existing TIMEOUT path (item 10).
    - Client:
      - `call-session.ts:65-70,183-186` (`tellShot`/`moveTo`): sends `{type:"shot"}` once
        open; a move made while ringing goes out on open.
      - `use-live-call.ts:22` sends each change of `shotIndex`.
      - The hook moved from the per-shot `Studio` into `Shoot` (`useShootCall`), with tools and
        frames passed down through `CallLink`.
    - Tests:
      - api `live.test.ts:569-628`: new shot turn, same-shot no-op, going back, outside the plan
        ends the call, move before ready, move past the budget.
      - web `:269`: one socket through next and previous, and `shot` messages sent.
      - web `:566`: a move while ringing is sent on open.
      - files `:476`: keeping the take moves the same call on.

## TDD evidence

- **api**: the tests were written first and failed 6 of 45 before the relay change
  (`r1_api_red.log`): the persona line, `DIRECTOR_CALL_TOO_FAST` ×2, shot turn, out-of-plan,
  move before ready. They passed after the change.
- **web**: the new and changed tests were written first and failed 10 of 17 against the
  round-0 code:

      × rings, hears and sees … (focus / aria-hidden)
      × carries one call through the shots …
      × keeps Director quiet while a take records the member's voice
      × ends at its time limit without calling it a failure …
      × says the microphone was refused (focus)
      × says why in the call's words, or the API's …
      × does nothing to mute or measure … hanging up just resets
      × survives Strict Mode's second mount … (first version)
      × tells the relay about a move … while it was still ringing
      × hangs up quietly … stops the worklet …

  After the change they pass (16/16). The remount test then moved to `<Activity>` (see item 1),
  and I added the page-level remount test when coverage showed the restart effect unexercised.
- **contracts**: `live.test.ts` was written alongside the module, not before it.

## Commands and output tails

    $ bun run lint
      ✔ bunx biome check .  ✔ lint:boundaries  ✔ lint:unused  ✔ lint:markers  ✔ lint:patterns
      ✔ lint:suppressions ✔ lint:prisma … ✔ bunx turbo run lint
    lint exit 0

    $ bun run check-types
     Tasks:    24 successful, 24 total

    $ bunx turbo run test --continue
     Tasks:    21 successful, 22 total
    Failed:    @repo/testing#test        (already failing on origin, see concerns)
    @repo/i18n:test:       Tests  11 passed (11)
    @repo/contracts:test:  Tests  31 passed (31)
    @repo/web:test:        Tests  180 passed (180)
    @repo/api:test:        Tests  167 passed (167)

    $ bun run --cwd apps/api vitest run --project unit src/modules/live/live.test.ts
     Test Files  1 passed (1)
          Tests  46 passed (46)

    $ bun run --filter @repo/api test:integration
    @repo/api test:integration:  Test Files  8 passed (8)
    @repo/api test:integration:       Tests  96 passed | 13 skipped (109)

    $ bun run --cwd apps/web test:integration test/director/live-call.test.tsx
     Test Files  1 passed (1)
          Tests  17 passed | 9 skipped (26)    (run together with avatar.test.tsx, whose cases are files-only)

    $ bun run --cwd apps/web test:integration:files test/director/live-call.test.tsx
     (files test "is sent once, and the call moves on to the next shot" passes)

    $ bun run --filter @repo/contracts coverage; bun run --filter @repo/api coverage
    @repo/contracts coverage:  Tests  31 passed (31)
    @repo/api coverage:        Tests  277 passed (277)

    $ bun run --filter @repo/web coverage
    @repo/web coverage:  Test Files  1 failed | 88 passed (89)
    @repo/web coverage:       Tests  1 failed | 520 passed (521)
    (the one failure is test/settings/avatar.test.tsx "says so when storage refuses the upload",
    see concerns)

    $ bun scripts/coverage.ts apps/web/src/modules/director apps/api/src/modules/live packages/contracts/src/live.ts packages/contracts/src/errors.ts
    78 source files, 3 reports: 0 below 100%.

    $ bun run gen
     Tasks:    6 successful, 6 total     (no drift; the regenerated error-code exports are committed)

## Decisions the review didn't make

- **Shot outside the plan** ends the call with `DIRECTOR_SHOT_NOT_FOUND`, like any other message
  the relay refuses. The client only ever sends shots from the plan.
- **Shot moves share the typed-turn budget** (3 per 10 s): each one costs a Gemini turn.
- **Time limit**: TIMEOUT counts as "ended", with a plain toast ("Calls last up to ten minutes.
  Call Director again to keep going."). The `failed.TIMEOUT` copy is gone.
- **Duplicate-tool guard** re-arms on every render rather than on phase changes (see item 7).
- **Strict Mode test**: vitest's browser runner doesn't run Strict Mode's second effect pass
  here, so both remount tests use `<Activity>` (see item 1).

## Concerns

1. **`@repo/testing` `stack.test.ts` fails on origin**, before and apart from my changes. It
   expects `GOOGLE_BASE_URL` in stack values, and `.env.example` now leaves it empty (commit
   69a4e46, "run local dev on the real Google services").
2. **`test/settings/avatar.test.tsx` "says so when storage refuses the upload"** fails on a
   moved stack. It refuses PUTs to the hard-coded `":59000/"`, while stack 7's RustFS is on
   59700. It's untouched by me and would pass on the default stack.
3. **Already below 100% in contracts**: `packages/contracts/src/pagination.ts` shows an
   uncovered anonymous function in the merged report. It's untouched by me; no remaining
   procedure seems to page.
4. **`origin/feat/mm/director-hackathon` moved again** (6cb1ddc, BigQuery events) after my
   rebase. The branch will need another rebase before merging; nothing it touches overlaps
   the live call.
