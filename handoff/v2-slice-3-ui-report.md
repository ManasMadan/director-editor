# Director v2, slice 3 front end: the roll on the shoot screen (report)

Branch `feat/mm/v2-recording-ui`, pushed. It is rebased on origin/master 25bc891, which includes slice 3's backend (#20) and point_at (#22). It does not need the recording branch merged in again: that branch is in master now.

## Blocker on master (needs the controller)

**Master's migrations fail on a fresh database.**
- `20261018200000_demo_guests` (#16) creates `CREATE POLICY owner_functions ON files.file …`.
- `20261018210000_recording` (#20) creates a policy with the same name on the same table: `CREATE POLICY owner_functions ON files.file FOR DELETE TO migrator USING (true);` (line 324).
- Result: `ERROR: policy "owner_functions" for table "file" already exists`, so `prisma migrate deploy` fails with P3009 / P3018.
- I reproduced it on stack 5 by recreating `app` and `app_test` and running `bun run db:deploy`.

**Likely consequences:**
- CI integration jobs fail.
- `bun run setup` fails on any new machine.
- Production fails at this migration if v1.4.0 ran it.

**Fix (one line, in the recording migration, which can never have applied anywhere):** rename that policy, e.g. `CREATE POLICY recording_functions ON files.file FOR DELETE TO migrator USING (true);`.

**Production:** if the migration was attempted there and recorded as failed, run `prisma migrate resolve --rolled-back 20261018210000_recording` before redeploying, after checking which statements did apply.

I didn't edit the shipped migration (outside my slice, and the guard rails refuse it). This also blocked every local browser test for me (see Tests).

## What I built

**Live session (API + contract):**
- New `mark` tool (event start/end, line, note). Gemini calls it; the browser stamps it with the recording's clock and numbers the attempts.
- New tool results `paused` and `not_recording` (in Gemini's words: "Recording is paused. Only their own tap on Resume starts it again.").
- New `roll` client message (recording, paused, resumed, done). It becomes a note to Director. Resumed and Done ask for a line; paused and done stop the quiet nudges.
- Persona v4 gets a ROLL section:
  - there is no shutter on the roll;
  - mark the start and end of each real attempt;
  - stay silent between the marks;
  - speak first after an end mark;
  - "pause" means telling them to tap pause, since Director can never resume;
  - check once before Done.

**`lib/roll.ts`** is a pure class with unit tests at 98%. It handles:
- the session start and its parts;
- ten-second slices handed to the uploader, on each part's own media clock (pauses don't count);
- pause and resume, including resuming into a new part when the browser stopped the recorder;
- a flip starting a new part;
- marks with attempt numbers;
- Done, and leaving the page (which ends the part and finishes the session).

**`hooks/use-roll.ts`** wires `Roll` to MediaRecorder, the client's recording mutations and `useSliceUploader`.

**`hooks/use-roll-shoot.ts`** wires the roll to the shoot screen:
- the roll starts when the camera's first picture is up after Start shooting, if Director is on and MediaRecorder exists;
- each flip starts a part;
- it tells Director where the roll is, including again on a reconnect;
- a paused roll mutes the mic and frames to Director;
- it auto-pauses when the tab is hidden and when the upload queue is full (five minutes);
- after Done it waits for the footage to upload, then opens the editor wrap.

**Shoot screen:**
- **Top band:** "● REC 03:12" with pause / Resume beside it, plus the progress strip. The strip shows ✓ a clipped take, • tried, ○ to do, and tapping a shot goes there.
- **Paused veil:** the picture greys, "Nothing's recording, and Director can't see or hear you", and a big Resume button. Space also resumes. Nothing said resumes it.
- **Done** takes the shutter's place.
- **"Saving your footage, N seconds to go…"** shows after Done.
- **Start card:** uses the spec's consent copy when the roll will run. It shows "N seconds of footage didn't upload last time. Sending it now." when an earlier visit left slices queued.
- **Shutter:** stays as the baseline when Director is off or recording can't start.

**Mock Live:** "here goes" sends a start mark, which gets no reply; "how was that" sends an end mark with a note.

**Docs:** the roll section in `docs/director.md`. **i18n:** `director.shoot.roll.*` and `intro.rollFirst` / `intro.rollAgain`.

## Acceptance (spec 12, slice 3): status

| Check | Status |
|---|---|
| Three attempts at shot 1 make three takes, no chat, each starting within 0.5 s of the first word | **Front end done:** Director's start/end marks reach `recording.mark` with the part's clock and the attempt number. Cutting and snapping to words is the backend's clipper, and clipped attempts become takes the editor already reads. **Not verified end to end:** that needs real Gemini plus the clipper, and local browser runs were blocked by the migration bug. |
| "pause" pauses and nothing from it is ever clipped; "resume" by voice does nothing, tapping Resume does | Pausing is touch only: the button, the tab hidden, or a full queue. Director can't resume: there is no tool for it, the persona says so, and marks during a pause answer `paused`. Pauses are sent to `recording.pause`/`resume`, which the backend never clips across. Unit tests cover pause and resume, and marks refused while paused. |
| Kill the tab and reopen: footage up to the last ten seconds is there | Slices go to the IndexedDB queue as they're made. Reopening sends the leftovers and the start card says so. Leaving finishes the session. |
| iPhone Safari | Not tested. The recorder picks MP4 where WebM isn't supported (`recorderFormat`), and the parts declare `video/mp4`. If Safari's MediaRecorder fails to start, the screen falls back to the shutter. |

## Calls I made

1. **The roll runs only with Director live.** Without Live there are no marks and no attempts, so the shoot keeps the shutter baseline. If Live drops mid-roll, recording goes on, and a reconnect re-tells Director where the roll is.
2. **The progress strip doubles as shot navigation** (a tap moves the shot and Director), because the "Shots" list is slice 5. ✓ means a clipped take; "good take" by review score is left for slice 5 / the editor.
3. **Leaving the page finishes the session**, as the spec says. Queued slices upload on the next visit (uploads are allowed after Done).
4. **The mock's mark cues** are "here goes" and "how was that". "ok I'm going" stays the slice 2 latency test's typed line.
5. **No "delete the last minute"** (a spec proposal), and **no battery warning**.

## Not done / for the controller

- **Existing browser tests are likely to fail in CI** (`shoot.test.tsx`, `director-live.test.tsx`, `use-studio` flows). With Live on and Chromium's MediaRecorder, the roll now replaces the shutter in those tests. Where `recording.start` fails, the screen falls back to the shutter, so some may still pass. I couldn't run them because of the migration bug. Per the time box, CI is fixed in the final PR.
- **New UI without browser tests:** `roll-parts.tsx`, `use-roll.ts` and `use-roll-shoot.ts`.
- **No live check with real Gemini** of the mark behaviour.

## Commits (on master 25bc891)

```
9372a80 feat(api): let Director mark attempts while the roll records, and tell it when it pauses
b293bbd feat(web): record the whole shoot as one roll, with pause, Done and Director's marks
c7fd7f0 feat(fake-google): mark an attempt in the mock Live API on "here goes" and "how was that"
05e6fef fix(web): number the roll's attempts, and pause while five minutes of footage wait to upload
fff19ed refactor(web): drop the roll hook's unused type export
a9822b6 docs(docs): describe the roll on the shoot screen
```

## Tests run

- `bun run check-types`: 24/24.
- Biome on apps and packages: clean. knip: clean.
- API live tests: 82 pass.
- Contracts: 67 pass.
- fake-google: 30 pass (`live.ts` at 100%).
- Web director unit tests: 88 pass (`roll.test.ts` 5).
- Browser and integration: none, because master's migrations fail (above). Stack 5 still holds the half-migrated databases; `bun run db:down` is done.
