# Live call fix: handoff (stopped before implementation)

Branch `fix/mm/live-call-direction` was created from `origin/master` (1551ba1) in the
worktree `.claude/worktrees/agent-a438aff22c6ec61d6`. The owner asked to stop before any
code changed, so nothing is committed or pushed, the branch is identical to master, and
there is no PR. `shoot-redesign.md` had not been started. Dependencies are installed and
`bun run gen` ran in that worktree. Stack 5 was never started, so nothing needs stopping.

## Root causes

### The screenshots were not taken on a Live call

The UI in 22.png and 23.png is the scripted, on-device mode ("Director Live"), not the
Gemini Live call:

- The header shows `LivePill` plus the `VoiceButton` (speaker). The call hides that button.
- The dock is `LiveDock` with the phone `CallButton`, screen share, the listen mic, pause
  and the X. On a call it would be `CallDock` with mute and hang up.

The production logs agree: no `/api/live` request, 9 `checkScene` calls and 8 `speak`
calls. The call only starts when the member taps the phone button
(`useShootCall.ring` in `pages/shoot.tsx`). Nothing starts it by default.

### 1. A take started on its own

Without a call, a take can start in three ways (in `hooks/use-session.ts`,
`hooks/use-studio.ts` and `hooks/use-body-guides.ts`):

1. The shutter button.
2. A spoken command, which is what fired here. `useVoice` runs the browser's
   SpeechRecognition through `intentOf` (`lib/intents.ts`). The `action` vocabulary in
   `packages/i18n/messages/en.json` (`director.live.voice.words.action`) is
   `action|record|roll|rolling|let's go|go|ready|start`. "okay let me go to the kitchen"
   contains the word "go", so it matched `action`, and `voiceActions.action` called
   `actions.record()`. That started the countdown and then the recording.
3. A raised hand. `useBodyGuides` gets `onRaise: studio.actions.record`. If
   `handRaised` (`lib/readiness.ts`, a wrist above the nose for 0.7 s) is true, a take
   starts. This also fires when the pose model misreads someone standing up or leaving
   the frame.

The scripted `ready` line even tells people to "say action, put a hand up high". On a
call there is a fourth path: Gemini's `start_recording` tool runs `requests.action` with
no check that the member answered.

"Auto 3s" is only the countdown length (`TimerButton`). "Auto" means the length is
learned from past takes (`countdownOf` in `lib/memory.ts`), not that recording starts
automatically. The countdown can't be cancelled because the shutter is disabled while it
runs. Nothing else on the page (keyboard handler or `aria-keyshortcuts`) can start or stop
a take.

Stopping a take works like this today: the shutter, the spoken `cut` vocabulary
(`cut|stop|that's it|done`), Gemini's `stop_recording`, and an automatic stop at the
shot's length plus 1.5 s.

### 2. It didn't feel like a conversation

- **Off a call (what the owner used):** nothing can answer. The on-device "ears" only
  match command words. Any other phrase shows up as the member's bubble
  (`session.voice.words` in `DirectorCaption`) and is then dropped. "Let's head over to
  the kitchen counter to film the cake!" is the `instruction` of a Gemini scene check,
  shown as a cue by `lib/cues.ts`. "No worries! Let's try that one more time." is the
  canned `say.backToOne` line that `sessionActions.retake` announces. It appeared because
  the accidental take was retaken, which also explains the "Take 2" chip.
- **On a call (latent problems the owner would hit next):**
  - The browser never tells Gemini when the member starts, stops or cancels a take.
    Gemini only knows about takes it started itself.
  - `hold` (`call-audio.ts` `createPlayer.hold`) silently drops Director's audio while a
    take records the member's voice. Gemini believes it was heard.
  - The microphone keeps streaming to Gemini during the take, so Gemini can answer into
    the void. The captions still show those words, which look like non-sequiturs.
  - After a take stops, nothing prompts Gemini to talk again.
  - The relay answers every tool call with `{result: "done"}` before the browser acts.
  - The persona (`live.setup.ts` `PERSONA`) does not say:
    - to answer every utterance;
    - to acknowledge movement ("tell me when you're there");
    - to ask "ready?" and wait for the answer before `start_recording`;
    - to announce staying quiet;
    - to resume talking after the take;
    - to adapt to the member's constraints (the market and indoors complaint).
  - The VAD settings (automatic activity detection, `START_OF_ACTIVITY_INTERRUPTS`) and
    the relay itself looked fine.

### 3. The doodles

All of them came from a Gemini scene check (fallback mode only, because `useSceneGuide`
is off on a call) and are drawn by `drawWalk` and `drawToLandmark` in `lib/doodle.ts`:

- **The large ellipse** is the landmark lasso (`sketchLasso`) around `check.landmark.box`.
  Gemini returned a box for the "kitchen counter" even though the counter is not in the
  frame.
- **The diagonal stroke** is the lasso's built-in overshoot: a 1.12-turn spiral in
  `lassoPoints` (`lib/sketch.ts`).
- **The arrow labelled "S m"** is the walking arrow's distance tag. The
  `director.shoot.doodle.meters` string (`{meters, number, ::.#} m`) is filled from
  `distanceMeters` = 5. In the Gochi Hand font, "5" reads as "S". Direction "forward" is
  drawn pointing down the screen from the member's position.

None of these is an instruction the member could act on: a distance guessed from one
frame and a place that is not in view. Two other overlays carry no label: the framing
arrows and the object highlights (lassos round props, with only the object name).

## What I would have built (input for the product spec)

- **Triggers:**
  - Remove the hand-raise start and the spoken `action` and `cut` commands, and change
    `say.ready`.
  - Add Enter and Space to start, cancel and stop, ignored when focus is in a control,
    plus `aria-keyshortcuts="Enter Space"` and a visible hint.
  - Make the countdown cancellable from the shutter, Enter, Space or Escape. Gemini's
    `stop_recording` should also cancel it.
  - Accept `start_recording` only if the member spoke (voice or typed) after Director's
    previous turn. Keep this as a pure function in `lib/live-call.ts` so unit tests can
    cover it.
- **Take events:** a new client message, `{type: "take", state:
  "countdown"|"recording"|"stopped"|"cancelled"|"refused", by}`. The relay turns each
  state into a Gemini turn (text kept in `live.setup.ts`):
  - countdown started by the member: announce "I'll stay quiet while you record";
  - stopped: talk again and ask how the take felt;
  - cancelled: ask what to change;
  - refused: ask if they're ready.
- **While recording:** keep `hold` and hide Director's captions, with a visible chip
  ("Director is quiet while you record").
- **Default call:**
  - Add a `live` entry to `system.info` features (`GOOGLE_CLOUD_PROJECT` set), so the
    browser knows whether to start the call without asking for the microphone in
    environments where Live is off.
  - Start the call once the camera is live, and resume the AudioContext on the first
    interaction.
  - In web tests, `GOOGLE_CLOUD_PROJECT` is empty, so existing tests keep Live off. The
    auto-call tests need a way to turn the flag on: either set the project in the "full"
    API variant and update every shoot test, or add a dedicated variant.
- **Memory and adaptation:**
  - New tools `remember` (a member constraint) and `adapt_shot` (where, framing, action).
  - The relay keeps the notes and adaptations per call and re-injects them into
    `shotMessage` and the greeting.
  - It sends them to the browser as new server messages (`memory`, `adapt`). The browser
    keeps them per video in sessionStorage and sends them back as a `context` message on
    the next call.
  - A shot card on screen shows the original or the adapted direction.
- **Typed input:** the relay already forwards `{type: "text"}` as a turn. Only the UI is
  missing.
- **Flip:** call frames come from the `<video>` element, and the call opens its own
  microphone, so flipping already re-sends frames from the new track without dropping
  the call. It needs a test. For selfie by default, open `useCamera("front")` instead of
  `shot.camera`.
- **Overlays:**
  - Drop the meters tag and the landmark lasso.
  - Label the walking arrow with a translated direction, and draw nothing once
    `inPlace`.
  - Label the framing arrows (the `shoot.framing.*` strings exist).
  - Drop the object highlights.
- **One mode:**
  - Removing share, mute, pause, the listen and voice toggles, and the call button
    removes a lot of now-dead code: `use-listening.ts`, `lib/intents.ts`,
    `recognizer.d.ts`, the screen share in `use-camera.ts`, `sharing` and `paused` in
    cues, perception and doodles, and the `voice.*` i18n keys.
  - These tests then need rewriting: `shoot.test.tsx`, `camera-parts.test.tsx`,
    `live-call.test.tsx`, `live-hooks.test.tsx` (useListening), `use-camera.test.tsx`
    and `lib/doodle.test.tsx`.
- **Persona (owner's latest note):** a friend helping shoot a reel, warm, casual and
  playful, with examples in `PERSONA`. The fallback TTS lines in `director.live.say.*`
  should be rewritten in the same tone.

## Left to do

Everything above, once the product spec is written. The spec should settle these open
points:

1. What the fallback notice looks like, and whether it offers to retry the call, given
   there is no call wording.
2. Whether the auto-stop at the shot's length stays.
3. How the web tests turn on the `live` feature.
