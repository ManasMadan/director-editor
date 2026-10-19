# Director live: UAT bug investigation

Read against `origin/master` at `943b9dcf`. Paths are relative to the repo root, and line
numbers are origin/master's.

Production runs `sha-3c9493c5` (#32, slice 4; `deploy/environments/production/release.yaml`).
Since then the Live code changed only by adding the `rate` tool (#33: `live.picks.ts`, and small
edits to `live.relay.ts`/`live.setup.ts`/`live.gateway.ts`). Everything below applies to
production except the parts that mention `rate`, which take effect with the next deploy. The web
shoot/live files are the same as production's.

Production Live config (no overrides in `deploy/environments/production/stack.yaml` or the
api secrets keys, so env defaults apply):

- Model `gemini-live-2.5-flash-native-audio` in `us-central1` (`apps/api/src/env.ts:124-132`),
  on the **v1** endpoint `google.cloud.aiplatform.v1.LlmBidiService` (`apps/api/src/modules/live/live.setup.ts:492-494`).
- Setup (`live.setup.ts:453-487`): `responseModalities: ["AUDIO"]`, voice Sulafat,
  `automaticActivityDetection { disabled:false, startOfSpeechSensitivity: START_SENSITIVITY_LOW,
  prefixPaddingMs: 200, silenceDurationMs: 700 }` (no `endOfSpeechSensitivity`, so the server
  default applies), `activityHandling: START_OF_ACTIVITY_INTERRUPTS`, `inputAudioTranscription: {}`,
  `outputAudioTranscription: {}`, `contextWindowCompression.slidingWindow`, `sessionResumption`.
- **No `proactivity` (proactive audio) and no `enableAffectiveDialog`.** Both exist for the
  native-audio model, but on Vertex I believe they're v1beta1-only. Check that in the Vertex docs
  before turning either on.
- Relay: rotates the upstream every 9 min (`live.gateway.ts:57`). It drops frames that arrive
  less than 1000 ms apart (`live.gateway.ts:58`, `live.relay.ts:433-441`).
- Browser: one 640-px-wide JPEG frame a second at q=0.6 (`apps/web/src/modules/director/lib/live-session.ts:42-47`).
  Mic audio is 16 kHz PCM in 100 ms chunks. With Live on, the shoot records as a roll
  (`pages/shoot.tsx:794`), so the shutter/take flow and its voice hold aren't used in production.

---

## Bug 1: captions come late compared with Director's voice

First, what the code does **not** do. Nothing waits for `turnComplete` or a buffer. The relay
forwards each `outputTranscription` chunk the moment it arrives (`live.relay.ts:541-552`). The
browser appends it to the caption state straight away (`hooks/use-director-live.ts:225-230`,
`lib/live.ts:91-98`). `turn` only marks the line finished (`use-director-live.ts:232`). Audio is
queued back to back with a 50 ms lead (`lib/live-audio.ts:14,159-179`). Audio and text go down
the same socket in Gemini's order. So any lag is either upstream (Gemini sends the transcript
after the audio) or in rendering. Our code adds no delay of its own.

### Ranked causes

1. **(Most likely) The native-audio model's output transcription trails its audio, and the client
   never lines them up.** Gemini sends `outputTranscription` as separate messages, after the audio
   it describes. The audio is then scheduled to play at once (`live-audio.ts:168`), but a caption
   can only show once its text arrives. The first words are heard before they can be shown, on
   every turn. Expected lag: a few hundred ms to over a second, worst at the start of a turn.
   - Fix (minimal): **measure first** (see below). If the lag at turn start is under about 600 ms,
     add a turn-start jitter buffer in the player. On the first audio chunk of a turn (after a
     `turn`/`interrupted`/flush), hold playback until the first transcript chunk of that turn
     arrives or 400-600 ms pass, whichever comes first. Play continuously after that. That's one
     extra state in `createPlayer` (`live-audio.ts:138-201`), started from
     `receive` in `live-session.ts:186-204`. If the lag is consistently above about 1 s, it's the
     model and can't be fully closed client-side. Then keep the captions as they are and say so,
     rather than delaying the voice that much.
   - Repro: extend the fake (`packages/fake-google/src/live.ts:175-182`, `say`) with a
     `transcriptDelayMs` option. Send N audio chunks, then the transcript D ms later. A
     `live-session` unit test (or e2e with the fake) then asserts that playback of turn 1 starts
     no earlier than the transcript (after the fix), or at most the bound later.
   - Confirm in prod: add a relay debug log per turn at `turnComplete`:
     `{firstAudioAt, firstTextAt, lastAudioAt, lastTextAt, audioMs (sum of PCM bytes/48),
     textChars}` relative to the turn's first message (`live.relay.ts:541-560`).
     `firstTextAt - firstAudioAt` is the upstream lag. In the browser, log
     `performance.now()` at caption commit against the player's scheduled start of the
     turn's first chunk.

2. **Main-thread cost on the phone delays caption paint, while audio, once scheduled, plays on
   the audio thread.** Each transcript chunk does `setCaptions` in `useDirectorLive`, which sits
   at the top of `useShoot`. So every chunk re-renders the whole `ShootScreen` tree
   (`pages/shoot.tsx:668-674,786-853`): Overlay, ShotCard, Controls, MarksLayer, MatchGhost,
   applyShotVersion, and so on. At the same time the main thread is drawing and JPEG-encoding a
   frame every second (`live-session.ts:111-129`, `lib/media.ts:57-77`) and base64-ing it
   (`media.ts:85-92`). It's also encoding mic PCM every 100 ms (`lib/pcm.ts:69-75`), decoding
   every audio chunk (`pcm.ts:78-80`, a per-character `Uint8Array.from`), and running the roll's
   MediaRecorder and slice uploads.
   - Fix: keep captions out of the screen's state. Put them in a tiny external store
     (`useSyncExternalStore`) read only by `DirectorCaptions`. Or memoize `Overlay`'s heavy
     children so a transcript chunk re-renders only the caption bubble.
   - Repro/measure: a React Profiler or Performance trace on a mid-range Android during a turn.
     Count `ShootScreen` commits per second and their duration. Long tasks over 50 ms during
     Director turns confirm it.

3. **New lines fade in from opacity 0 over 300 ms** (`components/director-captions.tsx:86`,
   `live-rise` in `live.css`, `both` fill). The first words of each Director line are invisible
   for up to 300 ms, which adds to (1). Fix: shorten it to about 120 ms, or animate only
   transform, not opacity.

Not a cause, but related: on `interrupted` the browser flushes the audio but leaves the caption
line open (`live-session.ts:196-197`). The next turn's words can then append to the cut-off line
until a `turn` arrives. Fix: call `onTurn()` (i.e. `turnEnded`) on `interrupted` too.

---

## Bug 2: Director stops talking mid-turn, and sometimes replies very late

Background: the Live API treats any `clientContent` as interrupting the model's current
generation ("A message here will interrupt any current model generation",
BidiGenerateContentClientContent). It also emits `serverContent.interrupted`, which the relay
forwards (`live.relay.ts:553-556`). The browser then drops everything still queued
(`live-session.ts:196-197` → `live-audio.ts:147-155`). Every app note in `live.setup.ts` is a
`clientContent` (`note()`, `live.setup.ts:154-156`), even the ones with `turnComplete:false`.

### Ranked causes

1. **(Most likely) The app interrupts Director itself with its own notes, mainly the shot-move
   note after Director's own `go_to_shot`/`skip_shot`.** The persona tells Director to call
   `go_to_shot` *and* speak ("one line of celebration, one about what's next",
   `live.persona.ts:28`, and the same for skip_shot at `:48` and in the example at `:81-83`). The
   browser answers `done` at once and navigates (`pages/shoot.tsx:528-531`, `:488-495`,
   `:573-574`). The `shotIndex` effect then sends `{type:"shot"}`
   (`use-director-live.ts:111-113` → `live-session.ts:89-94,317-320`). The relay immediately
   sends `shotMessage` with `turnComplete:true` (`live.relay.ts:379-396`,
   `live.setup.ts:162-172`). That lands a few hundred ms after the tool response, while Gemini
   is speaking the line the persona asked for. Gemini is interrupted, the browser flushes the
   queued audio, and a new turn starts ("Say in one sentence what this shot is"). The member
   hears Director cut off mid-sentence and then, after a gap, start over. The same mechanism
   applies to the other notes sent whenever the screen changes: take/roll notes
   (`live.relay.ts:356-364`), forgot (`:349-350`), and quiet nudges and the noise note (`:246-251`).
   - Fix (minimal): in the relay, don't send app notes while a model turn is in progress or a
     tool call is pending. Track `turnOpen` (set on the first `modelTurn`/`outputTranscription`
     of a turn, cleared on `turnComplete` or `interrupted`) and `pending.size > 0`. Queue notes
     in `note()`/`tell()`/`moveTo()` (`live.relay.ts:379-412`) and flush them in order at
     `turnComplete`. Collapse queued shot moves to the latest. Also, when the move answers
     Director's own `go_to_shot`/`skip_shot`, send the shot brief with `turnComplete:false`.
     Director has already introduced the shot; it only needs the brief.
   - Repro: make the fake behave like Vertex. When a `clientContent` arrives while it is mid
     `say` (split `say` into several audio messages over time), send
     `{serverContent:{interrupted:true}}`. Relay unit test in `live.test.ts`: the fake makes a
     `go_to_shot` call followed by a 3-chunk spoken line; the browser answers `done` and sends
     `{type:"shot"}`. Today the browser receives `interrupted`; after the fix the shot brief goes
     upstream only after `turnComplete`.
   - Confirm in prod: log every `interrupted` with `{msSinceTurnStart, msSinceLastClientContent,
     lastClientContentKind, inputTranscriptSinceTurnStart}`. Interruptions within about 1.5 s of
     our own `clientContent`, with no input transcription, are self-inflicted.

2. **False barge-in from Director's own voice (echo) or room noise, plus a member turn that never
   ends in noise.** The mic streams the whole time Director plays through the loudspeaker
   (`live-session.ts:225-229`, with no gating while `speaking`). With
   `START_OF_ACTIVITY_INTERRUPTS`, any speech the server's VAD commits to cuts Director off.
   `START_SENSITIVITY_LOW` helps, but `prefixPaddingMs: 200` (`live.setup.ts:470-478`) commits
   after only 200 ms of "speech". Phone AEC (`echoCancellation: true`, `live-audio.ts:94-96`) is
   weak with WebAudio playback at speaker volume. With `audio === "voice"` there are **two
   concurrent mic captures**: the camera's (`lib/media.ts:41-43`, opened by
   `useCamera(audio === "voice")`, `shoot.tsx:653`) and Director's (`live-audio.ts:94`). On iOS
   Safari a second audio capture can mute the first track or re-route the audio session, and AEC
   can stop applying to the WebAudio output. The plan in UAT was outdoors ("Intro in the
   Market"). Crowd voices would both barge in on Director and keep the VAD "in speech", so the
   member's turn never closes after `silenceDurationMs: 700`. Director then replies very late.
   - Fix (minimal): raise `prefixPaddingMs` to about 400-500 so a barge-in needs sustained speech.
     Gate mic chunks client-side while `player` is playing: drop chunks whose RMS is under a
     threshold (say about 2x the playback level read from the analyser) so echo never reaches
     the VAD, while a real barge-in still does. Open only one mic capture: reuse the camera
     stream's audio track for Director when `audio === "voice"` instead of a second
     `getUserMedia`. Optionally try `proactivity.proactiveAudio` (it lets the model ignore audio
     not addressed to it), after confirming Vertex v1 supports it.
   - Repro: there's no faithful unit repro for acoustic echo. Use a browser test with a fake mic:
     Chromium `--use-file-for-fake-audio-capture` playing Director's own TTS, plus a fake Live
     with server-side VAD stubbed as "any non-silent audio while speaking ⇒ interrupted". On a
     real phone (UAT), run with earphones and without: if cut-offs vanish with earphones, it's echo.
   - Confirm in prod: the same `interrupted` log as in (1). `inputTranscription` text around the
     interruption that matches Director's own words means echo; crowd words mean noise; nothing
     plus our own note just before means cause 1. Browser: log
     `track.getSettings().echoCancellation` and `track.onmute` for both captures, and count
     `interrupted` per minute per device. The relay's `noiseMessage` firing (3 interruptions in
     30 s, `live.pacer.ts:63-71`) is a proxy that's already in the code, but it isn't logged.

3. **Blocking tool calls freeze Director, and the pacer interrupts the wait.** Live function calls
   block: Gemini says nothing until the relay sends the `toolResponse`. `replan` waits up to
   **30 s** for `director.revise` (`live.relay.ts:127-135`, browser at `shoot.tsx:541-545`).
   `point_at` waits up to 12 s for a Gemini Flash locate (`live.marks.ts:21`). `mark` waits on a
   recording API call (`shoot.tsx:560-562`), and `rate` on a DB write (`live.relay.ts:624-630`).
   After `mark end` Director usually waits on both, one after the other, before its feedback. The
   persona's "While it works, say you're on it" (`live.persona.ts:47`) can't happen during a
   blocking call. Meanwhile the pacer counts only transcripts as activity, so 15 s into a replan
   it sends a `quietMessage` with `turnComplete:true` into a pending function call
   (`live.pacer.ts:39-49`, `live.relay.ts:248`). The relay also ignores
   `toolCallCancellation`, which Vertex sends when the member talks during a pending call: the
   schema at `live.messages.ts:16-56` doesn't read it. The browser goes on to apply the replan,
   and its answer lands on a call Gemini has dropped.
   - Fix: pause the pacer while `pending.size > 0` (call `pacer.take(true)`-like logic from
     `toolCall`/`answerTool`). Answer `replan` at once with `{result:"working"}` and send the
     new version as a `turnComplete:true` note when `revise` returns. Or declare `replan` as
     `NON_BLOCKING` if Vertex supports `behavior` on v1. Parse `toolCallCancellation` and drop
     those pending ids.
   - Repro: `live.test.ts` with fake timers. The fake calls `replan`, the browser doesn't answer
     for 20 s, and the test asserts no `clientContent` went upstream (fails today with the quiet
     nudge).
   - Confirm in prod: log tool call name, `msToAnswer` and result in `answerTool`
     (`live.relay.ts:636-658`). Correlate "late replies" with `replan`/`point_at` durations.
     `yourVersion.revise` request durations are in the api's request log already.

4. **Roll mode can leave Director in "stay silent" with nothing to end it.** On `mark start` the
   relay puts the pacer in take mode (`live.relay.ts:611-612`) *before* the browser has confirmed
   the mark (it may answer `not_recording`/`paused`/`busy`). Gemini is told "Stay silent from the
   start mark to the end mark" (`live.setup.ts:291`, `live.persona.ts:31`). If Gemini misses the
   end of the attempt, it stays silent and no nudge ever comes until the member speaks clearly.
   Separately, the "roll is on" note is often **dropped**. The browser sends it when the socket
   opens or the roll starts (`hooks/use-roll-shoot.ts:64-72,81-85`), but `note()` drops anything
   sent before Gemini's `setupComplete` (`live.relay.ts:407-412`). After a reconnect, Director
   may not know the roll is recording.
   - Fix: give a pending `mark start` a ceiling. After the shot's `durationSeconds` × 2 + 5 s with
     no `mark end`, send a `turnComplete:true` note ("[The attempt looks over; mark end and give
     your note.]") and clear the pacer's take. Set `pacer.take(true)` only when the browser
     answers `done`. Have the relay remember the last roll state and send it in `lineReady`
     (as it does for the version, `live.relay.ts:500-504`), instead of dropping it.
   - Repro: `live.test.ts`. Send `roll recording` before the fake's `setupComplete` and assert
     the fake later receives the roll note (fails today). Fake `mark start` with no end: assert a
     nudge after the ceiling.
   - Confirm in prod: log `mark` start/end pairs with durations, and starts without an end
     before the next start or call end.

5. **Upstream rotation cuts the turn in progress.** Every 9 min (or on `goAway`) the relay opens
   a new line. As soon as it's ready, `takeOver` closes the old socket (`live.relay.ts:310-317`,
   `:519-520`, `:527-539`), even mid-turn. The rest of Director's sentence is lost, pending tool
   calls on the old line are never answered (`live.relay.ts:655`), and the new line only speaks
   once the member does (`resumedMessage`/`catchUpMessage` are `turnComplete:false`,
   `live.setup.ts:217-234`).
   - Fix: when the next line is ready, wait for the current line's `turnComplete` with no pending
     tools before `takeOver`, capped by `goAway.timeLeft`, or about 20 s for the timer-driven case.
   - Repro: `live.test.ts` already drives rotation with the fake. Start a multi-chunk turn with no
     `turnComplete` and advance the clock past `rotateAfterMs`. Today the old socket closes
     before the turn ends.
   - Confirm in prod: log `takeOver` with `{turnOpen, pendingTools, reason: timer|goAway}`.
     Cut-offs at about 9-minute marks of a call (`director.call_started` time + 9 min) confirm it.

6. **Uplink congestion delays the member's voice (late replies) and starves the audio.** Each
   second the browser sends a 640×1138 JPEG (about 60-180 KB base64) on the same socket as the
   mic audio, with no `bufferedAmount` check (`live-session.ts:111-138`). The roll uploads
   1.5 Mbit/s of video slices at the same time (`lib/media.ts:9`, `hooks/use-roll.ts`). On a
   weak mobile uplink the mic chunks queue behind frames, so Gemini hears the member late and
   answers late. After a stall, a burst of audio can exceed the relay's 2× real-time budget
   (`live.relay.ts:101-104,427-429`) and end the call with `DIRECTOR_CALL_TOO_FAST`.
   - Fix: skip a frame when `socket.bufferedAmount` is over about 64 KB. Lower frames to
     about 480 px wide (Gemini downsamples anyway). Optionally pause frames while the member is
     speaking.
   - Confirm in prod: browser-side, sample `socket.bufferedAmount` every second. Relay-side, log
     the inter-arrival gap of audio chunks over 500 ms, and `DIRECTOR_CALL_TOO_FAST` ends
     (`director.call_ended` reason).

7. **(Lower) Playback underruns sound like stopping.** The player has only a 50 ms lead after an
   underrun (`live-audio.ts:14,168`). Downlink jitter leaves audible gaps mid-sentence. On iOS
   the shared `AudioContext` can also go `interrupted`/`suspended` when another capture starts
   (a camera flip reopens `getUserMedia` with audio, `media.ts:31-45`). Nothing resumes it
   except the next `liveAudio()` (`live-audio.ts:54-58`). Fix: on
   `context.onstatechange` to anything but `running`, call `resume()`. Measure underruns by
   counting `play()` calls where `endsAt < context.currentTime` inside a turn.

VAD and setup checks the brief asked about: start sensitivity LOW, prefix padding 200 ms,
silence 700 ms, end sensitivity at the server default, and interrupts on start of activity.
Echo cancellation, noise suppression and AGC are on for both captures. The browser does handle
`interrupted` (flush). Session resumption is on. Nothing holds or drops Director's turns except
`hold()` during the shutter flow's countdown and recording (`shoot.tsx:633-637`), which isn't
used in roll mode.

---

## Bug 3: when Director updates the plan, the screen moves to the next shot

How the shot is tracked: by **plan index** in the URL (`?shot=<index>`, `hooks/use-studio.ts:34-35`,
`pages/shoot.tsx:888-891`). The member's version never renumbers. `version.shots[].shot`,
`skipped` and `gaps` are all 0-based plan indexes (`lib/your-version.ts:24-99`), and the plan
itself doesn't change on replan. So a replan or adapt **cannot** move the screen by changing the
list. I found **no effect or handler that advances on a version change**. `useYourVersion` only
settles the new version and shares it (`hooks/use-your-version.ts:32-57`). The `replan` and
`adapt_shot` handlers never navigate (`shoot.tsx:497-518,541-545`). The only code paths that
navigate are `go_to_shot` (`shoot.tsx:528-531`), `skip_shot` on the current shot
(`shoot.tsx:488-495`), a kept take (`shoot.tsx:684`), the roll strip tap and roll Done
(`hooks/use-roll-shoot.ts:95-100,122-125`). So the move comes from a **tool call Director makes
during or just after the update**.

### Ranked causes

1. **(Most likely) Director calls `go_to_shot` (next shot) as part of the update turn, and the
   screen obeys without question.** The persona tells it to "use go_to_shot ... to move on once
   they're happy with this one" (`live.persona.ts:28`). After a replan/adapt confirmation the
   member says "ok"/"perfect", which reads as happy. MEMORY says "adapt_shot for the shot it
   changes now, and the other shots as you get to them" (`live.persona.ts:45`), which invites
   "getting to" the next shot. The browser executes any `go_to_shot` immediately
   (`shoot.tsx:528-531`). It isn't tied to anything the member said, and there's no log of it.
   - Fix (minimal): (a) persona and tool description: `go_to_shot` only when they ask to move on
     or agree to Director's suggestion to move on. Never right after remember/adapt_shot/replan in
     the same turn. Bump `PERSONA_VERSION`, and `live.test.ts` checks the rule is present.
     (b) In the browser, refuse a `go_to_shot` that lands within about 5 s of a version change
     made by Director (adapt/replan/remember), answering a new result like
     `{result:"refused", why:"They haven't asked to move on; ask first."}`. That's a small,
     deterministic guard in `useTools` (`shoot.tsx:556-577`) with a `lastVersionChangeAt` ref.
   - Repro: the fake can already script it ("I'm switching indoors" → remember + replan,
     `packages/fake-google/src/live.ts:115-123`). Add a cue that answers the replan with a
     `go_to_shot` to the next shot, like a model following the current persona. An e2e on the
     shoot screen asserts the URL's `shot` doesn't change after the guard (changes today). The
     model-side half needs an eval against real Gemini Live (a scripted text conversation:
     "I'm filming indoors" → "ok great"), counting `go_to_shot` calls. It belongs in the
     owner's UAT, not CI.
   - Confirm in prod: there's **no log of tool calls today**. Add an info log in
     `LiveRelay.toolCall` (`live.relay.ts:587-621`) with `{tool, args, shot: this.shot,
     msSinceLastVersionChange, msSinceLastMemberTranscript}`. A `go_to_shot` to `shot+1` within
     seconds of a `replan`/`adapt_shot` answer confirms it.

2. **After a replan the current shot can become a gap or skip, and Director moves the member off
   it with `skip_shot`/`go_to_shot`.** In the UAT replan of 10 shots, gaps were `[2,4,6,8]`
   (plan shots 3, 5, 7, 9). If the member was on index 2, their shot became a gap. The replan's
   answer to Gemini is only `memoryOf(version)` (`live.relay.ts:651-653`, `live.setup.ts:74-91`):
   "Gaps the edit fills, so nobody films them: shot 3, 5, 7, 9", and "Shots they skipped ...
   don't bring them up". It doesn't say which shot they're on, or that it's now a gap. Gemini's
   `<shot>` brief is still the original from setup (`live.setup.ts:137-140`). So Gemini acts to
   get them off it. `skip_shot` on the current shot navigates by design (`shoot.tsx:488-495`).
   It also adds a gap shot to `skipped` (`lib/your-version.ts:66-70`), so the shot ends up in both
   lists. The screen itself never reacts to its own shot becoming a gap, so the move only
   happens when the model decides to, which is why it looks random.
   - Fix (minimal): make the replan answer explicit. In `answerTool` add
     `onShot: this.shot + 1`, `onShotNow: "film"|"gap"|"skip"` and, when it's still filmed, the
     new brief of the current shot (`shotBrief` with `adaptationOf`). Then add one line: "Stay on
     shot N unless they ask to move; if it's now a gap, tell them and ask whether to go to shot M."
     In the browser, make `skip_shot` of a shot that's already a gap a no-op that doesn't
     navigate (`shoot.tsx:488-495`). Optionally, if the owner prefers it, move deterministically
     after replan when `!films(version, props.index)`, but only after Director's confirming turn
     ends, and say so.
   - Repro: web unit test of `toolResult` (export it or test through `useTools`). Version with
     `gaps:[2]`, `props.index = 2`, `skip_shot{shot:2}`: today it navigates and puts 2 in
     `skipped`. Relay test: after `replan` done, the toolResponse contains the current shot's
     status.
   - Confirm in prod: the tool-call log from (1), plus the replan result's `gaps`/`skipped` and
     `this.shot` at answer time. A move right after a replan that made `this.shot` a gap or skip
     confirms it.

3. **Numbering confusion between 0-based versions and 1-based tool arguments (lower).** The
   relay converts consistently: tools subtract 1 (`live.tools.ts:73,126,147`) and `memoryOf`
   adds 1 (`live.setup.ts:66`). But `revise.py` gives Gemini Flash the version "numbered from 0
   (add 1 for the plan's numbers)" next to a plan numbered from 1
   (`apps/ai/app/revise.py:53-66`), and the draft's numbers are taken as 1-based
   (`revise.py:106`). An off-by-one in the draft marks the *wrong* shots gap/skip, often the
   current one, which feeds cause 2. Fix: give the version to the model 1-based (convert
   `version.shots/skipped/gaps` before `model_dump_json`). Repro: pytest on `revise_prompt`
   asserting every shot number in the prompt is 1-based.

Adapt-only moves: `adapt_shot` itself never navigates (`shoot.tsx:503-506`, and the relay only
merges it into its version, `live.relay.ts:644-648`). A move after an adapt is therefore cause 1:
the model chains `go_to_shot` after adapting, especially with "the other shots as you get to
them".

Link to bug 2: each of these moves also sends `shotMessage` with `turnComplete:true` right after
Director's own tool call, which interrupts Director's confirmation line (bug 2, cause 1).

---

## Bug 4: take reviews and titles still use the original plan ("film outdoors", "in the Market")

### How the review gets its brief

1. **Take creation.** A shutter take goes through `DirectorService.addTake`
   (`apps/api/src/modules/director/director.service.ts:246-270`). A take cut from the roll goes
   through `apps/worker/src/recording/clip.processor.ts:183-197`. Both call the AI's `createTake`
   with only `videoId, shotIndex, kind, fileId, contentType, sourceUrl`.
2. **Queueing.** `Director.add_take` (`apps/ai/app/director.py:1013-1056`) queues `add_review`
   (`apps/ai/app/queues.py:112-130`) with the payload `{takeId, orgId, sourceUrl}`
   (`packages/jobs/src/queues.ts:173-177`). No version and no notes.
3. **The worker.** `apps/ai/app/worker.py:149-161` calls `Director.review`.
4. **The prompt.** `director.py:1116-1120` loads the `DirectorPlan` and takes
   `_shot(plan, take.shot_index)`, the **original** shot (`_shot`/`_ready_shots`,
   `director.py:427-439`). `director.py:1149-1150` then sends `"The shot:\n" +
   shot.model_dump_json()` (original title, scene, steps, script) plus the video.
   `REVIEW_INSTRUCTIONS` (`director.py:281-302`) scores "how closely the take follows the shot".
   An indoor take is therefore judged against "Intro in the Market", which gives the 35-52 scores
   and the "film outdoors on the street" notes.

### Why it can't use the member's version

- The version exists only in the api's table `app.director_version`
  (`packages/db/prisma/schema/app.prisma:222-238`), read by
  `apps/api/src/modules/your-version/your-version.repository.ts:17-23`.
- The AI service keeps none of it (`director.py:1401-1403`), and its `app_ai` role has no grant
  on that table: migration `20261018222000_director_version` only enables RLS.
- No Python counterpart of `applyShotVersion` exists
  (`packages/contracts/src/api/your-version.ts:90-108`).
- Even applied, `applyShotVersion` keeps the original `title`, `purpose`, `phoneAngle`, steps
  2..n and (with steps) `pose`. So "market" can leak through all of those.

### Titles

The version has **no titles**:

- `ShotVersion` is `shot/where/action/line/framing/camera` (`apps/ai/app/schemas.py:1362-1372`,
  `your-version.ts:55-62`).
- `RevisedShotDraft` (`schemas.py:1391-1405`) and `_changed` (`apps/ai/app/revise.py:78-95`)
  carry no title.
- The `adapt_shot` declaration doesn't either (`live.setup.ts:349-364`).
- `applyShotVersion` spreads the original shot, so the title is always the original's.

Where titles show:

- Editor: built from `yourVersion(...)` at `pages/edit.tsx:527`, then shown in
  `components/shot-board.tsx:44,51,238` and `components/edit-player.tsx:86,178`.
  `components/version-gaps.tsx:28` reads `plan.shots[i].title` directly.
- Shoot screen: `shoot.tsx:625` → `components/shoot-parts.tsx:154`.
- Live brief: `live.setup.ts:117`.
- Editor AI context: `apps/ai/app/editor.py:125`.

### Minimal fix

1. **Review against the version, read at review time** (one place covers both callers):
   - Add a migration with `GRANT SELECT ON app.director_version TO app_ai`. RLS already scopes it
     by org, and the precedent is `_found_by_pass` reading `app.recording_attempt` with raw SQL
     (`director.py:497-510`).
   - In `review()` (about `director.py:1118`), load the version for `(org, take.user_id,
     plan.video_id)` and validate it with `YourVersion`.
   - Add a Python `apply_shot_version` in `revise.py` that mirrors `your-version.ts:90-108`, with
     parity cases taken from `lib/your-version.test.ts`.
   - Send `"The shot, as they're filming it:\n" + applied.model_dump_json()` plus "What they've
     told you (always holds): - place: Inside", formatted as in `revise.py:60`.
   - Add one line to `REVIEW_INSTRUCTIONS`: judge against their version and notes, and never ask
     for the original's place or setup once they've changed it.
   - The alternative is to pass the version in the `createTake` body and the job payload. That
     touches more code (two callers, `packages/jobs`, generated contracts) and freezes the
     version at record time.
2. **Titles:**
   - Add an optional `title` (≤80, like `Shot.title`) to `shotVersionSchema` and Python
     `ShotVersion`, to `RevisedShotDraft` and `_changed`, and to the `adapt_shot` declaration.
   - Tell `REVISE_INSTRUCTIONS` (`revise.py:32-34`) to retitle any shot whose title names the old
     place.
   - Set `title: version.title ?? shot.title` in `applyShotVersion`.
   - The editor, shoot screen and live brief then follow automatically. Only `version-gaps.tsx:28`
     needs switching to the applied shot.
   - Deploy the AI service first: `ShotVersion` is `extra="forbid"` (`schemas.py:1365`).
   - Versions already saved stay untitled until the next replan or adapt. If that matters, fall
     back to "Shot N · <where>" when `where` is set and there's no title.

### Repro and confirmation

- pytest (`apps/ai/tests/test_director.py`): use the `ready_plan` fixture and seed an
  `app.director_version` row with `notes:[{kind:"place",note:"Inside"}]` and
  `shots:[{shot:0, where:"At your desk"}]`. Then `add_take`, then `review` with
  `gemini_output(REVIEW)`. Assert that the prompt Gemini received contains "At your desk" and
  "Inside", and doesn't contain the original scene. It fails today.
- vitest: `applyShotVersion(shot, {shot:0, title:"Intro at your desk"}).title`.
- Production: no error is logged. Compare `ai.director_take.feedback` with the member's
  `app.director_version.version`. Feedback that mentions the street or market while the notes
  say `place: Inside` confirms it.

---

## Bug 5: "Director couldn't review this take. Record it again."

The message is the i18n key `DIRECTOR_REVIEW_FAILED` (`packages/i18n/messages/en.json:453`),
shown by `components/shot-board.tsx:95` for `ai.director_take.status='failed'`. Only
`_fail_take` writes it (`director.py:1452-1467`). `_end_take` (`director.py:1442-1450`) fails a
take at once for any error that isn't retryable (`apps/ai/app/indexing.py:82-89`: 429, 5xx,
transport errors and timeouts are retryable). For a retryable error it fails only on the last of
3 attempts.

Production runs `sha-3c9493c5`, so `TakeReview` there has only
`bestStart/bestEnd/score/feedback`. The `reason` field (#33) and the take `index` (#35) are
**not in production yet**. They aren't the UAT cause, but they block the next deploy (cause 6).

### Ranked causes (production build)

1. **Retryable Gemini errors use up 3 attempts in about 15 s.** That covers 429
   RESOURCE_EXHAUSTED, 5xx, and the 120 s watch timeout. Retries are `attempts: 3`, backoff 5 s
   exponential (`packages/jobs/src/queues.ts:187-188`), with worker concurrency 3
   (`worker.py:201`). A roll session is cut into many takes at once (`clip.processor.ts:190`),
   which sends a burst of reviews to Gemini at the same moment. The watch timeout is
   `director.py:106,616`.
   - Fix: per-job options in `add_review` (`queues.py:127-130`), e.g. 5 attempts with backoff
     starting at 30 s. Keep the presigned read URL's lifetime (`director.service.ts:61`,
     `clip.processor.ts:68`) longer than the retry window.
   - Test: `gemini_error(429, ...)` with `final=False` raises `ReviewInterrupted`, and with
     `final=True` gives `failed`. This extends `test_director.py:2012`.
   - Logs: three `"take review failed"` (`director.py:1159`) with `ModelHTTPError` 429/503 or a
     timeout. Then `job.finished` with outcome failed and reason `ReviewInterrupted`, attempts
     1-3, and finally `director.take_reviewed` failed with `DIRECTOR_REVIEW_FAILED`. These also
     show up as BullMQ failed jobs.
2. **A partial token reservation is reported as a review failure, not a budget failure.**
   `usage.reserve` grants `min(per_review, left)`. Each in-flight review holds 120k
   (`apps/ai/app/settings.py:126-127`), and demo guests get 300k a day. The run is capped at
   `UsageLimits(total_tokens_limit=reservation.tokens)` (`director.py:1153`).
   `UsageLimitExceeded` isn't retryable, so the take shows `DIRECTOR_REVIEW_FAILED` instead of
   `AI_BUDGET_EXCEEDED`. An output-validation retry re-sends the video, roughly doubling the
   tokens, which makes the cap easier to hit. Concurrent reviews from one roll also reserve
   against each other.
   - Fix: fail with `AI_BUDGET_EXCEEDED` when `reservation.tokens < per_review`, or map a
     `UsageLimitExceeded` from a partial reservation to that code.
   - Test: like `test_director.py:2025`, with a low monthly budget.
   - Logs: `"take review failed"` with `UsageLimitExceeded: Exceeded the total_tokens_limit of N`.
     In the database, `ai.usage` rows with `feature='director-review'` show reservations under
     120000.
3. **Output validation fails** (`UnexpectedModelBehavior: Exceeded maximum retries (1) for
   output validation`, not retryable). The bounds are `bestStart/End ≤ 60`, `bestEnd ≥ 0.1` and
   `feedback ≤ 300` (`schemas.py:955-962`). A long two-part feedback sentence or a range past
   60 s trips them.
   - Fix: an unbounded draft output type, clamped and trimmed in code, as `ShotPlanDraft` and
     `repair_plan` already do.
   - Test: `gemini_output({**REVIEW, "feedback": "x"*301})` gives `failed`.
4. **The presigned take URL expires before the job runs** (30 min, `director.service.ts:61`,
   `clip.processor.ts:68`). That happens when the shared `ai-director` queue (concurrency 3,
   shared with plan, asset and create-plan jobs) backs up.
   - Logs: `"couldn't fetch a take"` with `status=403` (`director.py:1133-1138`). It fails at
     once. Confirm with the take's `updated_at - created_at` over 30 min.
   - Fix: sign the URL at review time, or give it a longer expiry.
5. **Gemini refuses the video** (400 "unable to process input"). This is unlikely for roll takes,
   which are re-encoded to H.264 MP4 with faststart (`apps/ai/app/clipping.py:236-275`). It's
   more likely for a browser-recorded WebM or fragmented MP4 from the shutter flow, or a take of
   about 15 MB, which is about 20 MB as base64 and near the inline limit.
   - Logs: `"take review failed"` with `ModelHTTPError` 400 and its body.
   - Size and type limits otherwise hold: 15 MB upload cap (`packages/contracts/src/files.ts:24-27`)
     against `MAX_TAKE_BYTES=16_000_000` (`director.py:101`), and only mp4, webm and jpeg are
     accepted. A file that isn't uploaded yet can't reach review: both callers store it first.
6. **Blocker for the next deploy (master).** `TakeReview` now carries `reason` and
   `index: TakeIndex | None` with list `max_length`s (`schemas.py:930-973`). That puts `maxItems`
   into the response schema. `apps/ai/tests/test_planner_schema.py:1-4` records that Vertex
   answered 400 to `maxItems` once and failed every index. Expect **every** review to fail with a
   non-retryable 400 once master ships. The log would be `"take review failed"` with
   `ModelHTTPError 400 INVALID_ARGUMENT`. The new bounds (`reason` 1-160, `visible` ≤800,
   `things` ≤30, transcript and moment limits) also add validation failures.
   - Fix before promoting: a `TakeReviewDraft` output type with no list bounds or defaults,
     trimmed into `TakeReview` in code.
   - Test: extend `test_planner_schema.py`'s sent-schema check to the reviewer agent
     (`director.py:612-617`). It should fail on master today.

To tell these apart in production, filter the ai-worker logs on `activity=director.take_reviewed
outcome=failed`. Then find the `"take review failed"` or `"couldn't fetch a take"` line with the
same `requestId` (`job:<id>`). The failure activity doesn't record the cause, so add
`cause=type(error).__name__` in `_fail_take`.

---

## Logging to add first (cheap, and it confirms bugs 1-3 in production)

In `apps/api/src/modules/live/live.relay.ts`:

- At `turnComplete`: `{firstAudioMs, firstTextMs, audioMs, textChars}`.
- At `interrupted`: `{msSinceTurnStart, msSinceLastClientContent, lastClientContentKind,
  inputTranscriptSince}`.
- Each tool call: `{tool, args, shot, msSinceLastVersionChange}`, plus its answer
  `{result, msToAnswer}`.
- `takeOver`: `{turnOpen, pendingTools, reason}`.
- Each note sent upstream: its kind, and whether a turn was open.

In the browser:

- `socket.bufferedAmount` samples.
- `AudioContext` state changes and audio underruns.
- Each mic track's `getSettings().echoCancellation` and `onmute`.
