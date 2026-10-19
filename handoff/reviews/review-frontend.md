I didn't write `/private/tmp/.../scratchpad/review-frontend.md`. My instructions say to return findings in this message and not write report files, so the full ranked review is below and you can save it there as-is.

I reviewed `origin/master` at 943b9dcf against v1.1.0, reading files with `git show`. All line numbers are `origin/master` lines under `/Users/manas.madan/Desktop/code/director-editor/`. **Verdict: not ready.** There is one confirmed blocker: under the production CSP, every save fails.

## Findings

**[blocker] apps/web/src/modules/director/pages/edit.tsx:179** - `heldPicture` calls `fetch(take.poster)`. The poster is a `data:` URL for video takes and a `blob:` URL for photos. Production `connect-src` is `'self' https://challenges.cloudflare.com <storage>`, which blocks both. I checked this in headless Chromium with the same CSP: `{"data":"blocked","blob":"blocked"}`. `render()` calls `heldPicture` on every save, so it always rejects and the member always sees "renderFailed". This is new in #36 and not deployed yet. `e2e/editor.spec.ts:103` skips when Director is off, so CI doesn't catch it. **Fix:** decode without a network fetch (draw the poster `<img>` onto a canvas, or `createImageBitmap` the take blob at its middle frame). Make the save e2e run with the real CSP.

**[major] apps/web/src/modules/director/lib/stitch.ts:173-215, 224-251; pages/edit.tsx:229-251 (the owner's freeze and long audio)** - The render loop moves on `requestAnimationFrame`, and the segment-end check (`video.currentTime < endSeconds`) only runs inside that loop. Nothing reacts to the page being hidden, and there is no wake lock during a render that lasts as long as the video. When the phone auto-locks or the tab is backgrounded:
- rAF stops and the canvas stops changing, so `captureStream` sends no new frames and the file shows one frozen frame.
- The take's `<video>` keeps playing past `endSeconds` into the recorder's audio.
- Photo and gap segments record a frozen frame for as long as the page is hidden.

The result is a multi-second single-frame freeze and an audio track longer than the video, which matches the owner's export. A second contributor is that the recorder is paused and resumed around every segment (lines 198, 211, 222, 235, 240, 250, 358). Pausing a MediaRecorder repeatedly is fragile in Safari's MP4 output, and Chrome now also picks MP4 first (`media.ts:11`). **Fix:**
- Take a wake lock for the render.
- On `visibilitychange` to hidden, pause the video and the recorder; resume when visible. Or abort with a "keep this screen open" message.
- End segments with a timer or `requestVideoFrameCallback`, not the rAF loop.
- Avoid pause/resume: load and seek the next segment before the current one ends and keep the recorder running.
- Advance `offset` by the time actually played, not the planned `endSeconds - startSeconds`, so captions and the look don't drift after a take that ends early.

**[major] apps/web/src/modules/director/pages/edit.tsx:552-559, 531; lib/edit.ts:5-6** - `readyToSave` only needs one filmed shot. Every unfilmed shot, not just the version's skips and gaps, becomes a `missing` clip, then a `gap` segment, then the nearest take's frame held for the whole shot (slow 6% push-in, silence). The captions of that shot's script are burned over it. That is another way to get "10 s of one frame", here by design. The `lib/edit.ts` header also says skipped and gap shots get no clip, which is no longer true. **Fix:** only `version.gaps` should be gaps. Block saving (or warn) while shots the member films are still unfilmed, and don't caption gaps.

**[major] apps/web/src/modules/director/lib/roll.ts:322-334 with packages/client/src/api/recording/upload-slices.ts:112-124** - `closed()` awaits `enqueue`, and `enqueue` awaits `send()`, which waits until the whole upload queue has drained. So `flip()` (roll.ts:199-206) doesn't open the new part until up to 5 minutes of backlog has uploaded. During that time the REC indicator still shows recording, nothing records, elapsed time is frozen, and Director's `mark` returns `not_recording`. **Fix:** have `enqueue` resolve once the item is stored, and expose draining separately (`done()` can wait for it).

**[major] apps/web/src/modules/director/lib/roll.ts:298-318; upload-slices.ts:115-118** - A slice refused because the queue is full is dropped, but `part.slices` and `edgeMs` have already advanced. The part therefore has a hole, the part-end `sliceCount` counts the missing index, and `footageThrough` (contracts `recording.ts:82-99`) returns null forever. Every later attempt in that part never becomes a take, and a WebM part with a missing middle slice won't concatenate anyway. **Fix:** pause recording before the limit (when backlog plus one slice would pass the cap), or accept the slice that crosses the limit and set `full`. Never drop a slice in the middle of a part.

**[major] apps/web/src/modules/director/pages/shoot.tsx:845-847; hooks/use-roll.ts:112-118** - `upload.error` is never shown on the shoot screen, and the `roll.uploadTrouble` and `roll.nearLimit` strings exist but are unused. Final refusals (`RECORDING_LIMIT_REACHED`, `RECORDING_STORAGE_FULL`) silently drop footage while REC keeps ticking. After Done, `SavingFootage` covers the screen with no way out while uploads retry offline. **Fix:** show the error and the near-limit warning. Give `SavingFootage` an "open the editor, it keeps uploading" action, since the queue is in IndexedDB.

**[major] apps/web/src/modules/director/lib/live-audio.ts:54-62; hooks/use-roll-shoot.ts:37-45, 112-117 (mobile Safari)** - The shared AudioContext is resumed only when a session starts. iOS suspends it (state "interrupted") on lock, app switch or a call. The roll auto-pauses on hide, but tapping Resume never resumes the context. The capture worklet runs in that same context, so after unlocking Director is both silent and deaf, with no notice (`hearing` stays true). **Fix:** call `liveAudio()` from the Resume tap, on `visibilitychange` to visible and on any shoot-screen tap. Watch `onstatechange`.

**[major] apps/web/src/modules/director/hooks/use-camera.ts:32-39** - On a flip the new camera opens before the old stream is stopped. Many Android devices reject a second simultaneous camera with `NotReadableError`, which this code maps to `"missing"`, so flipping shows "no camera". **Fix:** stop the current stream before opening the other camera (the roll starts a new part on a flip anyway), or retry once after stopping on `NotReadableError`.

**[major] apps/web/src/modules/director/pages/shoot.tsx:480-495, 528-532 (shot tracking against version changes)** - The screen's shot is only the URL `?shot`; nothing reconciles it with the member's version.
- A `replan` that skips the current shot, or turns it into a gap, leaves the member filming a shot their video won't use.
- `go_to_shot` isn't checked against `skipped` or `gaps`.
- `skip_shot` on the current shot jumps straight away. If it was the last filmed shot, `pageAfter` sends the member to `/edit?wrap=1`. In roll mode that unmounts the screen mid-roll: `roll.leave()` finishes the session without Done, and uploads stop until the next visit.

I found no front-end path that navigates on a version change alone; every jump comes through `skip_shot` or `go_to_shot`. **Fix:**
- After every `settle` in `useYourVersion`, if the current shot isn't filmed, answer Director and move to the nearest filmed shot.
- Refuse `go_to_shot` to a skipped or gap shot (a new `LiveToolResult`).
- While rolling, never leave for the editor on a skip; stay and let Done end it.

**[major] apps/web/src/modules/director/hooks/use-your-version.ts:50-57** - `replan` sends the version as it was before the call and then `settle`s the result. Changes made while it's in flight (a chip ×, an `adapt_shot`, a ↺) are overwritten locally. The `save` mutations are scoped, but `revise` isn't in that scope, so the server can also keep either version depending on timing. **Fix:** put `revise` in the same mutation scope, and reapply local changes made during the replan, or refuse other changes until it lands.

**[major] apps/web/src/modules/director/pages/edit.tsx:569-574, 724-727** - All editor choices live only in `useState`: picks, order, trims, drops, grades, caption fixes, style, sound and Tell-Director changes. A reload loses them, and so does the reshoot round-trip (the `reshoot` effect and the retake links in `ShotBoard`), because the editor remounts empty. **Fix:** persist the choices per member and template, through the API like `yourVersion`, or at least `sessionStorage` keyed by `videoId`.

**[major] packages/client/src/realtime.ts:133-145** - `director.changed` and `recording.changed` invalidate `api.director.key()`, which includes the `alignMatchCut` queries (contracts `director.ts:703`, POST-as-query, `staleTime: Infinity`). Every nudge re-runs Gemini alignment for every visible match cut, which costs AI budget and rate limit, and the transforms can change while the member watches. **Fix:** exclude `alignMatchCut` from the invalidation, or give it a key outside `director`.

**[major] apps/web/src/modules/director/lib/live.ts:91-108; hooks/use-director-live.ts:226-232; lib/live-session.ts:196-199; lib/slow-session.ts:217-234 (captions vs voice)**
- On Live, transcript chunks are drawn when they arrive, unrelated to the player's clock. Gemini sends transcription separately from audio, so captions run ahead or behind.
- `turn` marks the line done (screen-reader announcement and fade timer) when generation finishes, not when playback ends.
- `interrupted` flushes the audio but keeps the unspoken words in the caption.
- On the slower line the caption appears at once, and the voice arrives after a TTS call plus a fetch. The next turn also waits behind that TTS, because `speakInto` is awaited in the turn queue.
- Slow-line transcripts aren't filtered while held, unlike Live's (use-director-live.ts:154 vs :227).

**Fix:** have the player report when queued audio will play, and reveal each transcript chunk no earlier than its audio starts. On `interrupted`, trim the caption to the words already played. Mark a line done at `onSpeaking(false)`. On the slower line, show the caption when the voice starts (or when TTS fails), and don't await TTS inside the turn queue.

**[minor] apps/web/src/modules/director/hooks/use-roll.ts / lib/roll.ts:168-180** - Pausing (including the auto-pause on lock) doesn't flush the recorder. If iOS kills the backgrounded tab, up to 10 s before the pause is lost. **Fix:** call `recorder.requestData()` on pause and on `pagehide`.

**[minor] apps/web/src/modules/director/hooks/use-roll-shoot.ts:64-78; lib/roll.ts:199-201** - A flip while the roll is `starting` is ignored but `recorded.current` moves to the new stream. The first part records a stream the camera has already stopped, so nothing is recorded while REC shows. **Fix:** queue the flip until the roll is `recording`.

**[minor] apps/web/src/modules/director/lib/visuals.ts:38-48; components/match-ghost.tsx:33-41** - Off-DOM `<video>` waits for `loadeddata` with no `preload="auto"` and no timeout. `thumbnails.ts:66` sets `preload` for exactly this reason. On iOS this can hang `loadVisuals`, which leaves the render stuck at 0%, or never show the ghost. **Fix:** set `preload = "auto"` and add a timeout, like `videoFrames`.

**[minor] apps/web/src/modules/director/hooks/use-screen.ts:21-36** - A wake-lock request that resolves after unmount is never released, so the editor keeps the screen awake. **Fix:** release the sentinel in `.then` if already released.

**[minor] apps/web/src/modules/director/lib/slow-session.ts:142; lib/dictation.ts:71-83 (iOS, needs checking on a device)** - Dictation starts with no tap, from the Live failure path, and runs alongside `getUserMedia` audio. On iOS this probably fails `not-allowed`, or interferes with the roll's microphone track.

**[minor] apps/web/src/modules/director/pages/shoot.tsx:291 (WCAG 2.4.7)** - The TellBox input uses `focus:outline-none` and the form shows no focus ring, so keyboard focus is invisible. **Fix:** `focus-within` outline on the form, as `tell-director.tsx:246` does.

**[minor] apps/web/src/modules/director/components/roll-parts.tsx:76-85** - The global Space handler resumes recording even when Space activates a focused button or the Leave dialog's Stay. **Fix:** ignore events whose target is a button or inside a dialog.

**[minor] apps/web/src/modules/director/components/gap-strip.tsx:84** - The `aria-label` replaces the visible timecode and the filled, empty and skipped states (WCAG 2.5.3, and the state isn't announced). **Fix:** drop the `aria-label` or include that text.

**[minor] apps/web/src/modules/director/components/tell-director.tsx:246-264** - The submit button sits inside the `<label>` (interactive content in a label). **Fix:** move it out.

**[minor] apps/web/src/modules/director/components/asset-picker.tsx:104** - Autoplaying, looping video tiles have no pause (WCAG 2.2.2) and use mobile data. **Fix:** a poster with play on focus or hover.

**[minor] apps/web/src/modules/director/pages/edit.tsx:734-741** - A Tell-Director reply applies `applyActions` to the choices from when the request was sent. Picks made while it was pending are overwritten. **Fix:** apply inside a functional history update against current choices.

**[minor] apps/web/src/modules/director/pages/create.tsx:158** - The brief (idea, photos, conversation) is lost on reload. A failed brainstorm leaves the member's turn without a reply, so the next answer sends two member turns in a row. **Fix:** keep a `sessionStorage` draft and roll back the turn on error.

**[minor] Tests** - New flows have no e2e or `expectAccessible`: create from scratch, the roll shoot, the asset picker, Tell Director. `compose.ts`, `visuals.ts` and `slow-session.ts` have no direct unit tests. No test renders with the page hidden or under the real CSP.

## Verified clean
- Render-only: only `app/healthz/route.ts`, no `"use server"`, no `fetch` to `/rpc` or `/api`.
- Data: hooks imported by exact path, keys from the utils, errors through `errorMessageKey`, no `error.message`.
- Structure: new `src/app` pages are thin (`create/page.tsx` checked).
- i18n: no UI literals found. The English in `gap-strip.tsx:30-33` goes into model prompts, not the UI.
- Security: no `dangerouslySetInnerHTML`; sign-in `next` goes through `useNextPath`; the CSP drops the MediaPipe origins.
- Bundle: `@mediapipe/tasks-vision` removed; the landing hero is CSS only, as a server component.
- The landing hero's pause control and screen-reader order are correct.

## Not run
- `bun run lint:boundaries`, `test:stories` and the bundle budget: the main checkout is on another branch, and the budget needs a build.
- iOS and Android behaviour, other than the Chromium CSP check above.

## Files I created
- Source extract: `/private/tmp/claude-503/-Users-manas-madan-Desktop-code-director-editor/f1ddf0d8-5838-46aa-97e0-9a9cb55506ef/scratchpad/m/`
- CSP probe scripts: `scratchpad/csp.mjs` and `scratchpad/csp-check.mjs`

**not ready**