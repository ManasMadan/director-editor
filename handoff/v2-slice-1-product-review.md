# Director v2, slice 1: product review

Reviewed against the spec (`docs/superpowers/specs/2026-10-18-director-ux-redesign.md`,
slice 1 in section 12, quality bar in section 14), the engineer's report
(`v2-slice-1-report.md`), the nine evidence screenshots, and the code on
`feat/mm/director-v2` (966d296..4c1549d): `pages/shoot.tsx`, `hooks/use-studio.ts`,
`components/director-captions.tsx`, `lib/live.ts`, `hooks/use-director-live.ts`,
`lib/live-session.ts` and `apps/api/src/modules/live/live.setup.ts`, plus the new English
copy. I didn't run any suites or open a browser.

## Verdict

**Pass with two majors to fix before release.** The slice does what it promised. Nothing
said, no gesture and no Director tool can start a take. There's one screen. Director is
live from "Start shooting", and the camera and Director stay up across shots. The
removals are thorough, and the persona is right for the per-take baseline. The two majors
are small. First, ✕ during a take throws the take away without asking. Second, captions
put Director's reply above the line it answers, which brings back the "it didn't answer
me" feeling. Real-Gemini behaviour (first-word time, the flip comment in its own words,
the 9-minute rotation) and iPhone Safari's two microphone captures still need the UAT
run on a real phone.

## Acceptance checks

| Check | Result | Notes |
|---|---|---|
| Saying "okay let me go to the kitchen", "go", "ready", "let's go", "start" starts nothing | **Pass** | The listener, word lists and recogniser are deleted; a browser test sends each line through the relay to the mock Live API and checks nothing records (evidence 03). |
| Raised hands, walking out of frame start nothing | **Pass** (by absence) | The pose, hand, object, framing and timer code is deleted, MediaPipe is removed, and `actions.shutter` is the only start. To confirm on a phone in UAT. |
| The only controls are flip, the shutter, the text box | **Pass**, with ✕ allowed | Ruling below; the spec now says "plus ✕ to leave". |
| Flip mid-conversation: Director comments on the new view | **Pass** against the stand-in | The order is right: the new camera's frame goes up first, then the note. Whether real Gemini answers in its own words is for UAT. |
| Ten shots past ten minutes: no "call ended" | **Pass** against stand-ins | Rotation at 9 minutes or on `goAway`, session resumption with a catch-up fallback, a 30-minute cap. Not run for real; UAT step 10. |
| Front camera, opened only on the tap | **Pass** | `useCamera` no longer takes the plan's camera. |
| Camera and Live stay up across shots | **Pass** | One `ShootScreen` for the whole short; a test asserts no new `getUserMedia` and one session (evidence 08). |
| `live` in `system.info` | **Pass** | |
| Per-take baseline, cancellable 3-2-1 | **Pass** | Shutter or Escape cancels; auto-stop at the shot's length plus 1.5 s (evidence 05 to 07). |
| All removals from 6.2 | **Pass** | Every file listed in 6.2 is gone; "call" and "Director Live" wording is gone from the shoot and landing copy; CSP tightened. "AI credit" remains in the library dialog, which belongs to slice 7. |

## Rulings on the engineer's calls

1. **✕ "Leave the shoot" kept: approved.** It's navigation, not a camera control, and a
   shoot screen with no way out fails the quality bar's back and escape checks. It must
   ask before losing a take (major 1). Spec updated (6.1, slice 1 acceptance).
2. **Per-take consent copy until slice 3: approved.** Copy has to say what's true now.
   Spec 6.3 now quotes it as the copy until slice 3.
3. **6 typed lines per 10 s: approved.** Typing bursts are real, the relay still bounds
   abuse, and 3 was too tight for a fast typist.
4. **One caption per Director turn: approved.** Turns merging into one line read badly.
   The ordering of the two lines is a separate problem (major 2).
5. **The spoken wrap line removed: approved.** It was canned, and every word Director
   says comes from Gemini. The visual wrap card stays.
6. **Unused scene-check endpoint left in: approved for now.** Removing it changes
   `/api/v1`, so it goes in a cleanup. Spec updated: slice 16 removes the procedure, its
   AI agent, its limits and its docs.
7. **Not asked, also approved:** only two tools; rotation at 9 minutes with a 30-minute
   cap; the take review's native captions off by default; the darker glass (72%) for
   caption contrast; "on this site" honesty when Live is off (copy minor below).

## Rulings on the spec contradictions

- **The wireframe's ✕, pause, Shots and Done against "only flip, shutter, text box".**
  The acceptance line means camera controls. ✕ is in every slice. Pause and Done arrive
  with continuous recording (slice 3), and "Shots" with picks (slice 5). Spec 6.1 now has
  a "Which controls arrive when" paragraph, and slice 1's acceptance says "plus ✕ to
  leave".
- **6.3's consent copy.** It's written for slice 3. Until then the per-take copy the
  engineer wrote is the spec (6.3 updated).
- **Reconnects and the hourly limit.** Relay rotations never count. A new connection
  from the browser (its one silent retry after a drop, or Try again) does count, against
  20 an hour, which a normal shoot never comes near. Spec 6.7 updated.

## Fix tickets

### Major 1: ✕ during a take throws it away without asking

- **What:** during a countdown or recording, ✕ (and the browser's back) leaves at once
  and the take is lost. The same goes for a take on review that isn't kept yet, through
  the back gesture.
- **Where:** `LeaveLink` in `components/shoot-parts.tsx`, rendered by `Overlay` in
  `pages/shoot.tsx` in every phase, including recording (evidence 06).
- **Why:** the quality bar (section 14, Material 3) says "on the shoot screen it asks
  before ending a recording"; losing a good take by accident is the worst thing this
  screen can do.
- **Fix:** in setup, leave at once. In countdown, recording, preview or sending, ask:
  "Leave? This take isn't kept yet." with Leave and Stay. During recording, stop the take
  first so the question sits over a still frame. Handle the browser's back the same way.
  Add a test.
- **Spec:** 6.1 "Leaving" (added in this review).

### Major 2: captions put the reply above the line it answers

- **What:** `DirectorCaptions` always draws Director's line above the member's,
  whoever spoke last. After the member says something and Director answers, the
  member's older line sits at the bottom, as if still waiting for an answer. The
  member's line also stays up for minutes: in evidence 04, 05 and 07, "okay let me go to
  the kitchen" is still on screen through a flip, a countdown and a take review.
- **Where:** `components/director-captions.tsx`, `withTranscript` in `lib/live.ts`.
- **Why:** this is the owner's first complaint ("it doesn't feel like a two-way
  communication") coming back through layout. My own wireframe in 6.1 had the same
  order; it's fixed in the spec now.
- **Fix:** show the last exchange oldest first, with the newest line at the bottom,
  nearest the text box. Dim the older line. The member's line goes 8 s after Director
  has answered it. For screen readers, announce each line once it's complete (on the
  `turn` message, or after a short pause in transcripts), not every few words (today the
  whole `aria-live` container re-reads as words stream in).
- **Spec:** 6.1 "Captions read in order" (added).

### Minors

1. **Director talks over the 3-2-1, and its held words show up later.** The relay is told
   only when recording starts, so Director can be mid-sentence through the countdown.
   Also, transcripts that arrive while its voice is held still go into the captions, so
   after a take the member can read words they never heard. Fix: send a `countdown` take
   state (note: "they're counting in, go quiet"), hold from the first number, and drop
   Director transcripts while held. Spec 6.5 updated.
2. **No text box on the take review.** A member without a microphone can't answer
   Director's verdict ("was the light ok?"). Show the text box on review too, above Go
   again and Keep it.
3. **"Start shooting" twice in a row.** The template page's button and the shoot card's
   button have the same label, one tap apart. Rename the template's button "Let's shoot",
   or keep the card and say why it's there ("One tap to bring Director in").
4. **"Director can't join you on this site."** This reads oddly to a member. When Live is
   off, say "Director isn't available right now."
5. **The stop state of the shutter.** In evidence 06, the recording shutter looks like a
   dim red circle rather than the red square the code describes (possibly captured
   mid-animation). Confirm it reads as Stop at a glance on a phone.
6. **Shot progress dashes are faint** over bright camera pictures (evidence 02 and 04).
   They need 3:1 contrast against the picture (WCAG non-text contrast): put them on the
   glass, or add a shadow.
7. **The "Director" pill when live says only "Director".** Fine for now; when slice 2
   adds speaking and listening states, give it a word ("Listening", "Talking").
8. **Keeping a take still waits for the upload** before the next shot opens. This is
   expected in the baseline; slice 3 makes uploads background work.
9. **The scene-check procedure stays callable.** Covered by slice 16.

## Not proven yet (UAT covers it)

- Real Gemini: the first word within about 2.5 s of the tap, the flip comment in its own
  words, the persona's tone, silence during takes, speaking first after.
- The 9-minute rotation against Vertex's real `goAway` and resumption.
- iPhone Safari with two microphone captures at once (the camera's for voice takes and
  Director's own).
- Raised hands and walking out of frame on a real camera.

## UAT script for the owner, after release

Also in the spec, section 15, slice 1. How to run and what to send:
`docs/superpowers/specs/2026-10-18-director-uat.md`.

**Setup.** The head-nod template, phone in hand, a quiet room with a window. Turn on
screen recording with the microphone on. Run it on an iPhone (Safari) and an Android
(Chrome).

**Steps.**

1. Open the template, tap Start shooting, read the card, tap Start shooting, and allow
   the camera and microphone.
2. Wait for Director to speak, and answer its question.
3. Say "okay let me go to the kitchen", then "go", "ready", "let's go", "start",
   "action", "record".
4. Raise both hands for five seconds; walk out of frame and back.
5. Type "can you hear me?" and send it.
6. Tap flip, and say "can you see me now?".
7. Tap the shutter, then tap it again during the 3-2-1. Then start a take and let it run
   out by itself; watch it back and tap Go again. Record one more and tap Keep it.
8. Ask Director "can we do shot 3 now?".
9. During a take, tap ✕.
10. Keep shooting and talking for twelve minutes, moving through shots.

**Pass if:**

- nothing records in steps 3 and 4;
- the camera opens on the selfie side;
- the only controls are flip, the shutter, the text box and ✕;
- Director answers the typed line;
- after the flip, Director says something about what the back camera sees;
- the cancelled countdown records nothing;
- Director is silent during takes and speaks first after each one;
- shot 3 opens with no black flash, and Director carries on talking;
- ✕ during a take asks before leaving (once major 1 is fixed);
- there's no "Director lost the connection" or "half an hour" notice by minute twelve;
- the captions read in order, with the newest line at the bottom (once major 2 is
  fixed).

**Feel:**

- Director's first word comes within about 2.5 s of the second tap;
- answers come within about a second;
- nothing sounds canned;
- Director never talks over the countdown (once minor 1 is fixed).

## Spec changes made in this review

In `docs/superpowers/specs/2026-10-18-director-ux-redesign.md` (main checkout; carry it
to `feat/mm/director-v2` with the fixes):

- 6.1: which controls arrive in which slice; captions in order; leaving asks first; the
  wireframe's caption order fixed.
- 6.3: the per-take consent copy until slice 3.
- 6.5: the 3-2-1 row.
- 6.7: what counts against the hourly limit.
- Slice 1: acceptance and the UAT script.
- Slice 16: removing scene checks.
- The changelog.
