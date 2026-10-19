# Export sync: the broken saved Short

Branch `fix/mm/export-sync`. The first three commits went out as PR #40 (master `2da247fe`). After that the branch was rebased onto master and carries two more commits: `0d73d189` (web) and head `c83316ae` (ai).

## What the owner's file shows

`director-short.mp4` is a fragmented MP4 from Chrome's MediaRecorder, in 3 fragments.

| Fragment | Video | Audio |
|---|---|---|
| 1 | 0–3.36 s | 0–3.30 s |
| 2 | 3.37–17.07 s, including **one frame of 10.375 s** at 6.564 | 3.31–17.00 s, continuous |
| 3 | 17.07–20.42 s (100 frames) | 17.0–**38.89 s** (1027 AAC frames) |

So the recorder was writing sound the whole time while it got no picture frames: once for 10.4 s in the middle, and once for 18.5 s at the end. Those 18.5 s are frames that never reached the file.

## Root causes, reproduced in real Chrome

I bundled the v1.6.0 and master stitchers and ran them in Google Chrome through a harness (`scratchpad/harness/`), using numbered test-pattern takes, each with its own tone (`analyse.py` reads frame timing and which tone plays when).

1. **A frame was recorded only when Chrome decided the canvas had changed.** `stitch.ts` (v1.6.0 and master) used `canvas.captureStream(30)` and drew from a `requestAnimationFrame` loop.
   - Drawing only a `<video>` onto the canvas produced **no frames at all** in v1.6.0. Frames appeared only while a caption was drawn over it.
   - Reproduced: with captions only at 9.5–12 s, the file had a 2.49 s video track (all 75 frames captioned) against 12.2 s of sound. With captions at 0–6.5 and 9–11 s, it had a 2.97 s frozen frame and the sound ran past the picture. That is the owner's signature, and it is also why their captions "appear only in the final segment": the only later frames that made it into the file were captioned ones, packed together at the end.
   - In master, a gap with no look painted nothing, giving a 0.43 s held frame in the browser test.
2. **The recorder was paused and resumed around every segment**, while the clock was split. Picture timing came from rAF and from `video.currentTime < endSeconds && !video.ended` (old `stitch.ts:203`). Photos and gaps were timed by `performance.now()`. Sound came from each take's `<video>` playing in real time through `createMediaElementSource`. Nothing tied these together.
   - Master in Chrome had 0.1–1 s frames at every cut and 0.5 s more sound than picture.
   - A take that ended early ended its part early, while `offset += totalSeconds([segment])` (old `stitch.ts:371`) moved the caption clock by the planned length. Captions drifted, and the file came out shorter than the edit, which is the UAT's 4.7 s file for a 0:14 edit.
3. **Nothing handled a hidden page**, and there was no wake lock. With rAF stopped, the take kept playing into the recording, so the picture froze while the sound ran on.
4. **Unfilmed shots were rendered as the held frame of the nearest take, with that shot's script burned in.** On master, every `missing` clip became a gap segment (`edit.tsx` `segmentsOf`), and `editLines` captioned it.
5. **Tiny takes.** The clipper already refuses cuts under 500 ms (`apps/ai/app/clipping.py` `MIN_CLIP_MS`). The 0.1 s "takes" are Gemini's *best part*: `best_range` in `apps/ai/app/director.py` accepted any range over 1 ms, and `clipsOf` (web `lib/edit.ts`) played it.
6. **Saving was blocked under the site's CSP.** `heldPicture` (`edit.tsx:179` before the fix) `fetch()`ed a `data:` or `blob:` poster, which `connect-src` blocks, so every save failed.

## The fix

- **4245f3c7** (in #40): the held frame is decoded with an `<img>` (`posterPicture` in `lib/visuals.ts`). The CSP now lives in `src/lib/csp.ts`, so a browser test can run under the site's real policy.
- **8bb21b5d** (in #40): the render is rebuilt in `lib/stitch.ts`, with the timing logic in a new pure module, `lib/render-plan.ts`.
  - The timeline is fixed in whole frames, with one soundtrack decoded from the takes (`decodeAudioData`) and cut to exactly those frames, with 5 ms fades at each cut.
  - One clock drives everything, the AudioContext playing that soundtrack. Every frame is painted from the background up and sent with `requestFrame()`, so held pictures repeat at 30 fps.
  - The recorder never pauses between segments. Every take is loaded (with `preload="auto"` and a 20 s timeout) and seeked to its part's start before the render starts.
  - A take that runs short holds its last frame.
  - A hidden page pauses the recorder and the clock together, and the screen is kept on during the render (`lib/wake-lock.ts`, shared with the shoot's hook).
  - The picture runs a whole number of frames behind, matching how long the sound takes to reach the recorder (`baseLatency + outputLatency`). The last frame is held for the same time again, so the end of the sound isn't dropped.
  - The off-page videos in `visuals.ts` and `match-ghost.tsx` use the same loader.
- **0d73d189** (after #40), for UAT1-16:
  - Gaps the member's version leaves get their own `"gap"` clip state.
  - Neither gaps nor unfilmed shots get captions, through `playsAsGap` and `editLines`.
  - Saving is allowed with unfilmed shots, which play as gaps to fill, per spec 8.7 and the three-minute path. The note above the board says so and points at "Film it".
  - The wrap card now says "tap Save video" instead of naming a Next button that doesn't exist.
- **0d73d189** also adds `MIN_KEPT_SECONDS = 0.5` in `lib/edit.ts`: a kept part shorter than that plays the whole take.
- **c83316ae** (ai): `best_range` returns no part under 500 ms (`MIN_BEST_MS`), so new reviews stop producing tiny takes.

## Tests that reproduce it, and pass now

- **`apps/web/test/director/lib/stitch.test.tsx`** (Chromium).
  - **"keeps every cut's picture and sound together…"** renders the owner's shape: a 1 s take, a 0.4 s gap, a 0.1 s part, a 0.3 s gap, a 0.7 s part and a 0.5 s part, each take with its own colour and tone. It then reads every played frame (`requestVideoFrameCallback`) and the decoded sound, and checks four things:
    - no frame step of 0.1 s or more;
    - the picture is as long as the edit, and the sound within 3 frames of the picture;
    - none of the last take's sound is cut off;
    - every cut appears in picture and sound within 2 frames, and lands at its edit time within a frame.
  - That test **failed on master's stitcher** (a 0.433 s held frame) before the fix.
  - Other tests in the same file cover:
    - the video being as long as the edit when a take runs short (UAT1-20);
    - a hidden page;
    - the `requestFrame` fallback and a refused `play()`;
    - a take that can't be read;
    - cancelling a render.
  - Stable 3 out of 3 runs with the machine's load average above 30.
- **`src/modules/director/lib/render-plan.test.ts`** (unit) covers the owner's segment list (7 s, gaps, 0.7, 1, 0.1, 3.4):
  - whole frames end to end, with no drift;
  - every frame belongs to a segment, and a held segment is all its frames;
  - each segment's sound starts and ends with its picture to the sample, and the total sound equals the total picture;
  - mixing, fades, short takes and mixdown.
- **`src/modules/director/lib/edit.test.ts`** covers:
  - captions timed to each shot's own frames in the render plan, with none over gaps;
  - kept parts under 0.5 s;
  - gap and unfilmed clips.
- **`scene.test.ts`** checks that unfilmed shots are moments to fill.
- **`test/director/lib/site-policy.test.tsx`** checks the poster is read under the real `connect-src`. It failed on the old `fetch` before the fix.
- **`test/director/lib/media.test.tsx`** checks the off-page loader: it loads, fails on a file it can't read, and times out.
- **`apps/ai/tests/test_units.py`** checks best parts under half a second.

## Checks run on head `c83316ae`

- `bun run lint`, `bun run check-types` and web unit tests (43 files, 230 tests) all pass. AI unit tests pass (337).
- The browser files above pass.
- `test/director/edit.test.tsx` passes with the files profile (12 save-flow tests, real render, upload and My media), and its other 5 tests pass without it.
- `bun run type-coverage apps/web` fails on one line that this branch doesn't touch: `packages/client/src/api/recording/slice-store.ts:168`.
- These still fail on this branch:
  - `shoot.test.tsx` "says less the second time" (shot copy);
  - `director-live.test.tsx` "brings Live back on Reconnect" (context payload shape);
  - one or two flip and twist tests that come and go.

  None of them touch the editor or the render. I haven't rerun them on master to show they fail there too.

## What's left

1. **The encoder backlog: the most likely cause of the owner's missing 18.5 s.**
   - In Google Chrome under load, both headless and headful, MediaRecorder's video encoder fell behind real time, and `stop()` threw away what it hadn't encoded yet. The sound, which is cheap to encode, was complete.
   - With the fixed stitcher on a 12.2 s edit, the video tracks came out between 3.7 and 8.8 s. Master did the same (4.7 s) under the same load.
   - Waiting 8 s before `stop()` brought back every frame (370), which confirms the backlog.
   - MediaRecorder can't tell us when the encoder has caught up. In Chrome's MP4 output, `requestData()` returns empty chunks until a fragment closes.
   - The real fix is WebCodecs: encode with timestamps we choose, call `await encoder.flush()`, then mux. That needs a muxer such as mediabunny, which is a new dependency and needs your approval. AudioEncoder is in Safari 26.
   - The branch's tests (Playwright Chromium, WebM) don't hit the backlog. Chrome's MP4 output under load still can.
2. **My media's duration (UAT1-20, second half).**
   - The cut's `durationMs` is computed by the server from the picks (`_pick_ms` in `director.py`). It doesn't count gaps, and it doesn't apply the editor's half-second rule to old tiny ranges.
   - The fix is either for the client to send the length it rendered, which means changing the contract, the API and the AI service, or for the server to mirror the editor's rules.
   - The captions track on My media (`useCutCaptions`) also rebuilds clips without the member's version.
3. **UAT1-21 (no voice in the saved video).**
   - In UAT the takes themselves were silent or empty: 261-byte MP4s, and 1.5 s cuts with no speech. That points at the recording and clipper side (UAT1-17 and UAT1-18: "codec description changed" during the roll).
   - The new render does keep take sound; the tone test proves it.
   - The editor's sound toggle (`choices.sound`) also makes a silent video by design when a template uses the original's audio.
4. **Takes saved before c83316ae** keep their tiny ranges in the database. The editor now ignores them, but the server's `_pick_ms` doesn't.

## Follow-up (rulings 1–3), branch head f9477739

- 5371a365 fix(ai): `_pick_ms` applies the 500 ms floor to old takes (integration test).
- 598ad0a4 feat(api): `saveCut` takes `durationMs` (optional, positive int, ≤ 10 min), passed API → AI, stored; picks summed when absent. The editor sends `renderedSeconds(segments)` (whole frames, gaps included). Tests: AI integration (stored, refused 0 and > 10 min), API integration, client, web unit.
- f9477739 fix(web): after the last frame, "Finishing the video…" and a wait for the encoder (`lib/drain.ts` decision, unit-tested on the measured Chrome trace; `lib/recorded.ts` reads a recording's last frame time). Then the file is checked; short picture → `IncompleteRender` → one lighter retry (540×960, 2 Mbit/s) → otherwise "Your video didn't come out whole, so it wasn't saved…". Chrome findings: `videoKeyFrameIntervalDuration: 1000` gives 1 s pieces so progress is visible; `recorder.pause()` during the wait drops the encoder backlog, so it isn't paused, and the soundtrack now ends with the picture's tail instead of 1 s later.
- Chrome harness (load average 45–51): drain progressed 3.0 → 10.2 s of 12.3 s over 35 s at about 1 s per 3 s, hit the cap, and the file was correctly refused (11.3 s, then 8.3 s of picture); the editor would retry lighter. Browser tests: stitch + recorded 17/17 twice; editor save flows including both retry paths pass (one run had Postgres in recovery mode, rerun green).
