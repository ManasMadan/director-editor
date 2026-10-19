# Live turns: report

Branch `fix/mm/live-turns`, rebased on master `b9988e3d` (slice 16 merged). Head: see the
status line at the end. Every fix started with a test that failed on the code before it.

## What changed

### Director interrupting itself (apps/api)

- `live.gate.ts` (new): the relay holds every app note (shot brief, flip, take/roll note,
  restored/forgot, quiet nudge, noise note, attempt nudge) while a turn is under way:
  Director's audio or transcript arriving, a tool call pending, a tool answer just sent
  (Gemini carries on from it), or the member talking (input transcription, interruption).
  The turn ends at `turnComplete`, or after 5 s with nothing from either side. Held notes
  then go as **one** `clientContent` (so the first doesn't start a reply the second cuts
  off); shot moves collapse to the latest, built when sent.
- I wait for the reply's `turnComplete` after a tool response rather than flushing at the
  moment the response goes: a note sent right behind the response interrupts the reply
  Gemini starts from it (with `turnComplete:false` it would leave Director silent).
- A move Director made itself (`go_to_shot`, or `skip_shot` of the current shot) is
  briefed with `turnComplete:false` and "don't introduce it again".
- Rotation: the fresh connection takes over only between turns with no pending tool call,
  capped by goAway's `timeLeft` minus 1 s (20 s on the timer). Pending calls of the old
  line are dropped at hand-over so notes don't wait on them.
- Typed text still goes at once (the member's own barge-in). The browser still flushes on
  `interrupted`, which now only follows the member (voice or typed).
- Tests: `live.test.ts` "Director's turns, never cut off by the app", rotation tests,
  `live.gate.test.ts`.

### Shot jumps after a plan change

- Relay: replan and adapt_shot answers now carry `theyAreOn {shot, status: film|gap|skipped,
  say}` ("stay on it", or "it's now a gap: ask whether to go to shot N").
- Persona v5: go_to_shot only when asked or on a yes; "ok/great/perfect" isn't a yes;
  never move after remember/adapt/replan; say you're on it *before* calling replan; never
  skip a shot they didn't ask to skip; an example of asking after a replan. Tool
  descriptions match. `PERSONA_RULES` checks them.
- Browser (`lib/move-guard.ts`): for 20 s after Director's adapt_shot/remember/replan,
  go_to_shot and skip_shot of the current shot are answered `not_asked` unless the
  member's words since the change ask to move on (English cues), or the member has said
  anything since a refusal (so other languages work on the second try). go_to_shot to a
  skipped/gap shot is `not_filmed`. New results in `LIVE_TOOL_RESULTS` (openapi
  regenerated) with Gemini-facing explanations in `TOOL_RESPONSES`.
- A skip of the last filmed shot while rolling no longer sends the member to the editor.
- Logs: every tool call is logged at info as `live tool call {tool, outcome, shot,
  waitedMs}`: no arguments, so no member words.
- I did **not** auto-move the screen to the nearest filmed shot after a re-plan (the
  frontend review asked for it): that is exactly the "screen moves on its own after a
  plan change" the owner reported. Director now tells the member and asks instead;
  `nearestFilmed` exists in contracts if the owner wants the automatic move.

### Late or blocked replies

- Quiet nudge paused while any tool call is pending (`Pacer.toolPending`), counted again
  from the answer.
- The member reads "Director's re-planning your shots, one moment…" under the captions
  while a replan runs.
- Roll: an attempt's quiet starts when the browser answers `done` to `mark start` (not on
  the call); after max(2 × shot + 10 s, 20 s) with no end mark Director gets a note asking
  whether the attempt is over (and to stay silent if not).
- Roll and take state are remembered: told before the greeting if they came before
  Gemini was ready, and restated after a non-resumed hand-over.
- Gateway: messages the browser sends at socket open (version, "roll is on") were lost
  while sign-in/plan loaded; they're now kept (up to 64) and replayed into the relay.
- Deadlines: replan 45 s (AI's own 25 s plus margin), point_at 25 s (locate 20 s).
- Newest connection of a member wins (old one gets CONFLICT); a ws heartbeat (15 s) hangs
  up on sockets that stop answering pings.
- Audio over 2× real time after a stall is dropped (warned once a burst) instead of
  ending the call; frames are skipped once 128 KB is waiting upstream (the browser skips
  them at 64 KB of its own socket backlog); only audio/text past 1 MiB ends the call. The
  frame gate is 800 ms so jitter doesn't drop half the frames.
- A second adapt_shot of the same shot no longer wipes the first one's rows in the
  relay's copy (zod 4 keeps undefined keys; it also stored `name` in the version).
- Re-plans vs saves: revise now shares the saves' mutation scope (packages/client); the
  web reapplies changes made during a re-plan on top of its result; the API keeps a
  re-plan only if the stored version is unchanged since it started (row held with
  `FOR UPDATE`; integration test in `apps/api/test/your-version.integration.test.ts`).

### Captions

- `lib/caption-store.ts`: captions live in an external store read with
  `useSyncExternalStore` by `DirectorCaptions` only, so a transcript chunk no longer
  re-renders the shoot screen.
- `lib/voice-clock.ts`: follows the player's queue on the AudioContext clock. Director's
  words show as the voice reaches them (even pace, 15 chars/s, from the turn's first
  sound); words that arrive after their moment show at once. On `interrupted` the words
  not yet reached are dropped (the member's own words are kept) and the line ends; on
  `turn` the line ends when the queued voice has played.
- I stayed out of `live-audio.ts` as asked, so the clock mirrors the player's scheduling
  (start = max(now, end of queue)) rather than reading it from the player. If the web fixer
  makes `play()` return its scheduled start, the clock can read that instead.
- What can't be fixed client-side: Gemini sends output transcription after the audio it
  describes, so at the start of a turn the first words can't be shown before they arrive.
  Delaying the voice to wait for them would add that lag to every reply, so I didn't.
- Measurement: relay info log `live turn` (and the `director_turn` analytics row) now has
  `voiceMs` and `captionLagMs` (first transcript minus first audio, at the relay). On the
  phone, `directorLiveTimings()` in the remote inspector console returns the last 50 turns'
  `{textAfterAudioMs, queuedAheadMs, heldMs, voiceMs}` (`lib/live-debug.ts`). There was no
  existing browser debug log, so this is new; nothing is sent anywhere.
- New lines rise in from 60% opacity over 120 ms (was 0% over 250-300 ms).
- Slower line: a reply is captioned when its voice starts (or when TTS fails), and the
  next turn no longer waits for the TTS fetch.

### Echo and VAD

- Both getUserMedia calls request echoCancellation, noiseSuppression and autoGainControl
  (asserted in the browser test). Only Director's own capture feeds Live. With
  `audio === "voice"` the camera also holds a second mic capture for the recording; I left
  that (merging them means feeding Live from the camera stream, which is reopened on every
  flip, in files the web fixer owns) and it's worth trying on iOS.
- `prefixPaddingMs` 200 → 400, with a comment: phone speaker echo let through by AEC was
  enough to cut Director off. Start sensitivity LOW and silence 700 ms are kept.
- An "interrupted" info log records `{msIntoTurn, msSinceNote, lastNote}`, so production can
  tell an interruption the app caused from the member's.

## Proactive audio and affective dialog on our endpoint

Not confirmed. Our setup sends them where the Gen AI SDK's Vertex converter does
(`setup.generationConfig.enableAffectiveDialog`, `setup.proactivity.proactiveAudio`), but
the SDK talks to Vertex on `v1beta1` by default (`_api_client.py` sets `api_version =
'v1beta1'` for Vertex, and the Live URL is `google.cloud.aiplatform.{version}.LlmBidiService`),
so every published sample uses v1beta1. Our relay uses `...aiplatform.v1.LlmBidiService`.
The v1 setup proto isn't public, Vertex's docs pages render without the content, and the
release notes only say the model (GA Dec 2025) has both features. There's also a known
naming mismatch on the Gemini API (`enableAffectiveDialogue`, flat `proactiveAudio`;
js-genai #1953), though that's the developer API, not Vertex. The env comment from slice 16
says both were checked live; if Vertex refused a field on v1, every call would fail at
setup with a 1007 close ("live upstream closed" error log with code 1007, members moved
to the slower line), which production logs would show at once. I couldn't call Vertex from
here. The reviewer's other point stands too: with proactive audio on, the model may choose
not to answer the app's own notes (the greeting, a shot brief); worth watching in UAT.

## Tests and checks

- `bun run lint`: passes (after dropping one unused re-export knip found).
  `bun run check-types`: passes.
- Head: `cfe304cb` on `origin/fix/mm/live-turns` (9 commits on master `b9988e3d`).
- Unit: api 373 (one unrelated timeout flake, `env.test.ts` "listens on API_PORT", passes
  alone), contracts 72, client 107, web lib 151.
- Integration: `apps/api/test/your-version.integration.test.ts` 5/5.
- Browser: `apps/web/test/director/director-live.test.tsx` 28/29 in the full run; the one
  failure ("tells Director about a flip at once…", `hook.current` undefined) passes when the
  hook tests run alone, so it looks order/timing flaky. I also fixed a stale expectation in
  "brings Live back on Reconnect" (it expected the old `adaptations` context shape).
- fake-google: untouched (the api tests use their own in-file Live stand-in, the browser
  tests a socket stand-in).

## Left for others or not done

- From the API review, left to the controller as asked: take numbering for "use the second
  one", session-pass queueing, stock errors, the synthetic flag, the `checkScene` commit
  title, and reviewing takes against the member's version (bug 4).
- If the fresh connection fails during a rotation, the call still ends even though the old
  one is healthy (review minor); not changed.
- The hand-over doesn't wait for a fresh resumption handle, only for the turn to end.
