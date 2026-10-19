# UAT run 1 — production v1.6.0 (director.mmadan.in), 2026-10-19 night

Tester: automated product UAT (headless Chromium 1248 via playwright-core 1.63, fake camera from the owner's indoor footage, 720x1280 @ 30 fps y4m; the microphone is a WebAudio track the harness "speaks" macOS `say` lines into, injected through getUserMedia so lines can be said at chosen moments in one session).
Phone profile: 390x844, DPR 3, touch, Android Chrome UA. Desktop: 1440x900.
Instrumentation (`scratchpad/uat/inject.js`): every live-relay WebSocket message in and out with timestamps, every Director audio chunk's scheduled play time (AudioBufferSourceNode.start), chunk stops (barge-in flushes), aria-live caption text changes, long tasks, JS errors. Console errors and 4xx/5xx/failed requests logged per page (`scratchpad/uat/logs/`).
Scope (per controller update): scripted flows plus Live, recording, editor and render; a second tester covers the exhaustive click-through.
Caveats: headless Chromium, desktop-class CPU, no real network throttling unless stated; Director's audio is muted locally (timing measured from the schedule, not from a speaker). Network from the owner's Mac.

## Setup and landing

- Landing (phone, unthrottled): TTFB 1176 ms, LCP 1512 ms, CLS 0.0002, load 1673 ms, 323 KB script transferred, no horizontal scroll (scrollWidth 390). Screens: `screens-run-1/01-landing-phone.png`, `01-landing-phone-full.png`.
- Hero mock: the "REC 01:12" pill wraps onto two lines at 390 px (see UAT1-01).

## Sign-in and demo (phone)

- `/sign-in?demo=1` ("Try it now, no sign-up"): the private guest demo did NOT start in this harness, in headless Chromium or in headed Google Chrome. Turnstile showed "Verify you are human", then "Verification failed" after a click; the page shows two alerts at once: "Your own demo couldn't start just now..." and in red "The security check couldn't load. Check your connection, allow challenges.cloudflare.com...". Screens: `02-signin-demo.png`, `02b-signin-after-turnstile-click.png`. Most likely Cloudflare scoring the automated browser as a bot, so not by itself proof that phones fail, but two things are real regardless: (a) the console shows a CSP violation from the sign-in page, `Connecting to 'data:,' violates ... connect-src 'self' https://hagen.challenges.cloudflare.com ...` / `Fetch API cannot load data:,` (Turnstile probes `data:`; if Cloudflare reads the blocked probe as a bot signal, real members lose the guest demo too), and (b) the copy contradicts itself: "couldn't load ... check your connection" while the widget visibly loaded and asks for a tap. See UAT1-02, UAT1-03.
- The page title for a "Try it now" visitor is "Welcome back / Sign in with your email and password." (UAT1-04).
- Fallback works: "Use demo account" fills the form, "Sign in" lands on /library within ~2 s, with no captcha. All testing below uses the shared demo account (`demo@director.mmadan.in`), so footage from this run is visible to the next demo visitor (known S2).

### Guest demo, second try

- With a non-automation-flagged browser (headed Google Chrome, `navigator.webdriver` false) `/sign-in?demo=1` signed straight in as a private guest and landed on /library in about 3 s. So the Turnstile failure above was the harness, not production. UAT1-02 stays open only for the CSP `data:` console error and the contradictory copy, and is downgraded. Everything from session 2 on runs as a private guest (header avatar "G").

## Live session 1: shared demo account, head-nod, shot 1 (about 2 min of Gemini)

Shared demo account. Template page, "I'll speak", "Let's shoot", start card, "Start shooting".
- Start card copy (roll version): "Director records the whole time you're shooting, chat included... Pause any time. Your browser asks for the camera and microphone next." Shown before any getUserMedia (none in the log before the tap). PASS for consent before the prompt.
- **FAIL: on the shared demo account, `POST /rpc/recording/start` returns 403 (DEMO_ACCOUNT_LOCKED by design), and the screen silently falls back to take-by-take with a red shutter.** It never shows the REC indicator, Pause or Done, yet the card just told the member everything is being recorded. The member is never told nothing is recording and they must tap the shutter (UAT1-05). Screen: `08-s1-first-turn.png` (red shutter, no REC pill).
- First words: Director greeted "Hey there! Ready to jump into this?" and the caption was on screen when I checked about 6.9 s after the tap (precise timing lost, see note). Screens `07-s1-joining.png` and `08-s1-first-turn.png`.
- "hi, yes I'm ready, let's do it" (spoken): Director replied (audio and caption), but kept talking or re-talking for over 20 s (waitQuiet hit its 20 s cap), so the turn was long. Fuller timing comes from session 2.
- "okay let me go to the kitchen", then "go", "ready", "let's go", "start", "action", "record": no take started, no countdown, URL unchanged. PASS (nothing recorded). `09-s1-after-trigger-words.png`.
- Typed "can you hear me?": spoken reply finished 7.9 s after send. PASS (answered). `10-s1-typed-reply.png`.
- Flip, then "can you see me now?": answered (13 s total including the flip). The fake device has one camera, so the back-camera content check isn't meaningful here. `11-s1-after-flip.png`.
- "can we do shot 3 now?": Director moved the screen to `shot=2` (shot 3), and the card changed. PASS. `12-s1-shot3.png`.
- **FAIL: tapping ✕ ("Leave the shoot") mid-shoot left at once with no Leave/Stay dialog**, straight to the template page, with Director and the camera running a moment before. Then Back returned to the shoot start card (the session is gone). This is on the take-by-take fallback with no take in progress, so the dialog arguably wasn't required. It's re-checked in roll mode below. `13-s1-leave-dialog.png` (shows the template page; its video area is black, the YouTube embed hadn't loaded).
- Harness note: per-page logs were lost on navigation in this session. From session 2 on, events stream to `scratchpad/uat/logs/events.jsonl`.

## Live session 2: guest, head-nod, roll mode (slice 1 re-run, about 1.5 min of Gemini)

Events: `scratchpad/uat/s2.json`, analysis by `analyze.py`. Times are seconds on the page clock.

| Check | Result | Evidence |
|---|---|---|
| Consent card before the camera prompt; nothing records before the tap | PASS | `15-s2-guest-startcard.png`; first getUserMedia came 3.7 s after the tap |
| Roll indicator visible the whole time | PASS (REC mm:ss pill, red, top-left) | `17-s2-first-turn.png`, `21-s2-roll-ui.png` |
| Camera opens on the selfie side | PASS (`facingMode:"user"`, mirrored preview) | gum log |
| **"Start shooting" to Director's first word ≤ 2.5 s (4 s worst)** | **FAIL: 7.32 s** | tap 3.36 → main thread blocked by one **3757 ms long task** starting 50 ms after the tap → camera getUserMedia 7.10 → socket created 8.19 → open 9.66 → first audio arrives 10.62, plays 10.68. See UAT1-06 |
| Director's first line | "Hey there! Welcome to the shoot. How much time have you got?" (fine, one ask) | |
| Reply latency, spoken "hi, yes I'm ready" | 1.03 s to first audio. PASS (≤ 1.5 s) | |
| Reply latency, "okay let me go to the kitchen" | 4.24 s. FAIL (replan tool ran first: `remember Kitchen`, `replan "film every shot in the kitchen"`, then `go_to_shot 1`) | |
| Reply latency, typed "can you hear me?" | 1.55 s (borderline; spoken answer "I can now! Go ahead whenever you're ready.") | |
| Reply latency, "can we do shot 3 now?" | 4.20 s. FAIL (> 1.5 s) | |
| **Nothing records on "go / ready / let's go / start / action / record" (steps 3 and 4)** | **FAIL**: right after "Start action record." Director called `mark {event:"start", line:"So the first one is like this.", note:"Did the head wiggle with a smile."}`, which opens an attempt on the roll. It never sent a matching `end`, so a dangling attempt was left open when it moved to shot 3. See UAT1-07 |
| **No false takes** | **FAIL**: the member's "Hi. Yes, I'm ready. Let's do it." was marked as an attempt at shot 1: `mark start` + `mark end` with line "While traveling around India..." and note "Said the line clearly, with good hand gestures.", then Director said "That was great, really clear. Let's move on to the next shot." and `go_to_shot 1`. The member never said the line. See UAT1-07 |
| Quiet nudge | "Still with me? No rush." fired about 16 s after the first turn, landing on top of the member's answer; the caption ran it into the next line with no space: "Still with me? No rush.That was great..." (UAT1-08) |
| Typed line answered | PASS | `19-s2-typed-reply.png` |
| "can we do shot 3 now?" | PASS: `go_to_shot 2`; the card shows Shot 3 at once; camera never lost picture (248 samples at 50 ms through the move, readyState ≥ 2 and track active every time: no black flash) | `20-s2-shot3.png` |
| Kitchen chip and "changed for you" | Shown: "Kitchen ×" chip; Shot 3 card Where/Do/Framing all "changed for you" with restore icons | `21-s2-roll-ui.png` |
| **✕ during the roll asks before leaving** | **FAIL: no dialog.** ✕ ended the shoot at once (session `done`, 85 s recorded) and went to the template page. Back then lands on a fresh "Start shooting" card | `22-s2-x-pressed.png`, GET /rpc/recording/sessions |
| Caption timing | The on-screen caption (aria-live text) shows the first words **0.43 to 1.03 s after Director's voice starts** (5 turns: 0.54, 0.43, 0.73, 0.67, 0.44, 1.03), although the transcript text reached the browser 0.2 to 0.3 s *before* the audio played. The caption is held back by rendering, not by Gemini. The tail of a turn's transcript arrives up to 3.2 s after its audio ends. See UAT1-09 (relates to U2) |
| Barge-in | 3 `interrupted` messages; Director's audio was flushed each time (all three were the member's trigger words or line talking over a nudge) | |
| Performance trace (20 s requested, 8 s captured) with camera, Live and roll running and one conversation turn | main thread busy 14.7%, 0 long tasks > 50 ms, 600 frames drawn in 8 s, 3 DroppedFrame events. Desktop-class CPU: a mid-range Android will be several times slower | `scratchpad/uat/trace-shoot.json` |
| Long tasks over the whole session | 4: **3757 ms at the Start tap**, 135 ms and 100 ms around leaving | |

Copy note: the Kitchen replan answer was "OK, the plan's updated – we'll do all the shots in the kitchen now." The quality bar bans "plan" in Director's speech (UAT1-10).

## Live session 3: guest, head-nod, slice 2 conversation (about 2.4 min of Gemini)

Events: `scratchpad/uat/s3.json`; CPU profile of the Start tap: `scratchpad/uat/start-tap.cpuprofile`.
Controller note received during this session: the uploaded slices of recording sessions 01a1511d (session 2) and 01a15121 (session 3) were deleted by the controller while cleaning storage. Takes or editor results from those two sessions are not product evidence; any check that needs them is marked "rerun" and redone in a fresh session.

| Check | Result | Evidence |
|---|---|---|
| Start tap to first word | **FAIL: 4.58 s** (target 2.5 s median, 4 s worst). Tap 4.42 → socket created 5.00 → **socket open 7.98 (3.0 s for the relay to accept)** → first audio 8.94, plays 8.99. No long task this time (CPU profile: 4.6 s of 5.5 s idle, AudioContext 202 ms). The 3.76 s long task in session 2 didn't recur, so it's 1 of 2 tries, cause unknown | s3.json, cpuprofile |
| **Director starts from the member's version** | **FAIL**: the socket-open `context` carried the remembered "Kitchen" version (shot 0 Where: Kitchen), yet Director's first line was "Hey there, ready to jump in? **Are you planning to film outside like the shot says?**" (reproduces B5: messages sent at socket open are lost) | s3.json 7.98 out context; turn at 8.94 |
| Top bar at 390 px (roll mode) | **FAIL**: shot dots 8-10 sit at x 395-483 and **"Leave the shoot" (✕) at x 610: off-screen, so there's no way to leave the shoot on a phone** except Done or the system back. Pause button 36×36 and shot dots 28×28, both under 44 px | geometry dump; `23-s3-topbar.png`; UAT1-11 |
| Step 1 "ok I'm going": answered | **FAIL**: transcript "Okay, I'm going." came through (18.62); Director said nothing for 16.7 s until the member's next turn | s3.json |
| Step 2 typed "can you say my line again?" | PASS for reading: 1.44 s, "The line is: 'While traveling around India…'". **But Director then marked an attempt on the roll while it was reading the line itself** (`mark start` 35.20, `mark end` 36.86, note "nailed the line, good energy") and praised the member: "You nailed the line and had great energy! Maybe try the gesture a little bigger next time?" The member had said nothing. False take from Director's own voice (UAT1-07) | `24-s3-line-read.png` |
| Step 3 reworded line, no correction | PASS for no correction, but **FAIL on reaction**: Director's answer to the reworded line was the quiet nudge "Still with me? No rush." 3 s after the member finished. No `mark` for this real attempt, so the real attempt is lost and the fake one stays | s3.json 52.8 → 55.77 |
| Step 4 "what if I do this one with my grandma instead" | Comment PASS ("That's a great idea! Let's have Grandma do the nod, that'll be perfect."), card changed (`adapt_shot` shot 0: action "Grandma does the nod, you react", camera back). **But it also overwrote Where from "Kitchen" to "Inside"**, which nobody asked for. Latency 4.36 s (FAIL ≤ 1.5 s) | `25-s3-grandma.png` |
| Step 5 silent 40 s: one nudge at about 15 s, at most a second | PASS: one nudge ("No worries at all, just say when you're ready.") about 13 s after Director's last turn ended; then silence | |
| Step 6 talk over Director: "wait, wait" | **rerun**: my "wait" landed after Director had finished (the harness's speech wait mis-fired); it got "Take your time." 3.7 s later. Barge-in itself: the one `interrupted` in this session flushed audio at once | |
| Caption lag (first words on screen after voice starts) | 1.01, 1.86, 0.38, 0.72, 0.44, 1.63, 0.17 s; median 0.72 s, worst 1.86 s on the long turns. Transcript always arrived 0.2-0.3 s *before* the audio. Reproduces U2 | |
| Caption joins | "…a gesture of agreeance."You nailed the line…": two sentences glued with no space (same as UAT1-08) | |
| Long tasks | 3, max 214 ms (at the tap) | |

## Live session 4: guest, head-nod, slices 3 and 5 (about 3 min of Gemini) and barge-in rerun

Events: `scratchpad/uat/s4.json`. Recording session 01a15125 (its slices were NOT among the ones the controller deleted).

| Check | Result | Evidence |
|---|---|---|
| Start tap to first word | PASS this time: 2.38 s (tap 3.66, socket open 5.03, first audio 6.00). Three tries so far: 7.32 / 4.58 / 2.38 s | |
| **Director honours the member's earlier choice (Kitchen / Inside, from memory)** | **FAIL**: first turn "Is that a busy market street you're in? … You're inside right now; can you find a spot outside?"; after attempt 1 "If you want that busy market background, we could switch to the back camera." Director re-asks for the outdoors the member already declined (U1/U5 family; quality bar: never repeat a declined instruction) | turns 6.00, 12.36, 38.34 |
| **Barge-in: Director stops within 0.3 s** | **FAIL: 0.72 s** (member starts "wait, wait" 13.889 → `interrupted` 14.610 → 30 queued chunks stopped 14.611). Stopping is instant once the relay says so; the delay is server/Gemini VAD | s4.json |
| Director answers "wait" | **FAIL**: no answer for 17.9 s, then the nudge "Still with me? No rush." | |
| **Quiet nudge never talks over the member** | **FAIL**: "Still with me? No rush." started at 32.79 while the member was still saying attempt 1 (33.10 end), and was glued to the next line: "Still with me? No rush.Nailed the line" | UAT1-08 |
| Three attempts at shot 1 with chat between ("let me do that again") | **FAIL**: after attempt 2 Director said "That take was great… Let's move on to the next shot." and moved to shot 2 on its own, although the member had just said "Let me do that again". Attempt 3 (shot 1's line) was then accepted as shot 2 ("That was a good demo of the first nod!"), the wrong line for that shot | turns 61.27, 78.24 |
| **Director advances and marks takes the member didn't do** | **FAIL**: with no member action, Director marked takes on shot 3 ("good clear nod") and shot 4 ("nailed the quick nod", "You nailed the quick nod that time!") and moved on twice (`go_to_shot 3`, `go_to_shot 4`). The camera footage is just the owner talking. Then "You did the quick side nod." after a pause (UAT1-07) | tool log 85-102 s |
| Slice 5 "actually use the second one" | **FAIL**: not acknowledged; Director answered "You nailed the quick nod that time! If you're finding the background noise is cutting you off, try some earphones…" (no `pick` or tool call). Editor order check is **rerun** (the editor mixes takes from deleted sessions) | turn 104.16 |
| Voice "pause" | Not paused; Director answered "Just tap pause whenever you need!" (reasonable; the quality bar only needs touch to resume) | `30-s4-after-voice-pause.png` |
| Pause button | PASS: veil "Nothing's recording, and Director can't see or hear you. Tap Resume (or press Space)…", `roll paused` sent | `31-s4-paused.png` |
| Voice "resume" while paused does nothing | PASS (still paused 3 s after) | |
| Pause hides the member from Director | PASS as far as testable: asked "what did I just do?" during the pause and Director never described it | |
| Locking or hiding pauses | **not exercised**: the harness couldn't make the page hidden (no visibilitychange fired in headed Chrome when another tab was brought to front) | |
| Reply latencies (member stops → Director's voice) | 2.6, 6.1, 6.2, 2.9, 6.9, 3.3, 3.1, 7.1 s. **All FAIL** the 0.8 s median / 1.5 s worst bar. Director makes 1-3 tool calls (`mark`, `go_to_shot`, `adapt_shot`) before each spoken answer | analyze.py stimuli table |
| Caption lag (first words on screen after voice) | 0.70, 1.68, 0.39, 1.23, 1.15, 0.94, 0.85, 1.11, 0.85, 0.72, 1.39, 0.41, 0.22, 0.42, 0.64, 0.36, 0.60, 0.60 s; median about 0.7 s, worst 1.68 s (U2 reproduces) | |
| Caption sentence joins with no space | every multi-sentence turn: "you're in?You'll want", "next shot.Great, for this one", "Moving on.This one's" | UAT1-08 |
| **Closing the tab mid-roll, then reopening** | **FAIL**: reopening shows a plain "Start shooting" card, with no "footage didn't upload, sending it now" and no way to finish the old session. Tapping Start made a *new* session (01a15129). Sessions 01a15125 (tab closed) and 01a15121 (navigated away) are still `status: recording, finishedAt: null` and never reach the editor as a finished session (UAT1-12) | GET /rpc/recording/sessions; `34-s4-reopen.png`, `35-s5-restart.png` |

## Session 5: restart and Done (about 10 s of Gemini)

- Start shooting on the reopened page → REC 00:02 in a new session → Done → "Saving your footage" → editor in 6.2 s (`/edit?audio=voice&wrap=1`). PASS for Done to editor. `36-s5-saving.png`, `37-s5-editor.png`.
- Editor content mixes takes from all this guest's sessions, including the two whose slices the controller deleted, so take counts, "couldn't review" and missing takes are **rerun**. What is product evidence regardless:
  - **Reviews still say outdoors** (U5 reproduces): shot 1 "Good audio clarity, but try filming the full introduction outdoors in the market…"; shot 2 "remember to film outdoors on the street"; shot 3 "next time film locals tilting their heads at street stalls", although every shot was changed to Kitchen/Inside. Shot titles still "Intro in the Market".
  - **Shot 1's chosen take is 0.6 s** for a 5.3 s line (U8 family).
  - Wrap card copy: "I cut your takes together, best moments first. Make any last changes, then tap Next." The editor's button says **Save video**; there's no Next (UAT1-13).
  - Editor layout at 390 px: the shot board shows shot columns side by side; shot 1's column is about 120 px wide, so "Intro i…" truncates, "Take 3 of 4" wraps and the review card runs one or two words per line (UAT1-14). `37-s5-editor.png`.

## Live session 6: slice 7, the three-minute path (fresh guest, about 2.5 min of Gemini)

A fresh guest (guest 2) was made by "Try it now" in desktop Chrome (landing to /library: 9.0 s) and its cookies moved to the phone profile; on the phone profile Turnstile refuses the automated browser. Events: `scratchpad/uat/s6.json`. Recording session for guest 2 is clean (not among the deleted ones).

| Check | Result | Evidence |
|---|---|---|
| Quick start reachable on the phone | It sits below the fold on /library at 390×844 (y ≈ 780) under "Bring your own Short" and "Describe your own". The 3-minute path's main entry needs a scroll | `38-s7-library-phone.png` |
| "Tap Quick start; Start shooting" | **FAIL (extra steps)**: Quick start opens the template page, not the shoot. The member still has to find "Let's shoot" (and, the first time, pick "I'll speak") before the start card | `39b-s7-stuck.png` |
| Director speaks by 0:45 | PASS: tap to first audio 2.10 s. Wall-clock estimate from the landing page about 0:16 (landing to library 9 s, library to shoot about 4 s, tap to voice 2.1 s; my harness's own 15 s stall excluded) | |
| "I've only got three minutes" | Director: `remember {kind: time, note: "3 minutes"}`, `replan "3 minutes"` (3.8 s), then "Got it, we'll move quick. I've replanned the remaining shots to fit in that time. Done, I've adapted everything to fit." In practice the replan only skipped shot 3 (later, with "since you're indoors and short on time, maybe we just skip this one?"). 9 shots still to film at 3 minutes | turn 71.27 |
| **Director stays responsive** | **BLOCKER: runaway tool loop.** From 104 s to 193 s Director called `mark {event:"end", note:"explained the topic well"}` **about 60 times**, one every 0.8-1.7 s, each answered `done` (the last three `not_recording` after Done), and **said nothing for 60 s** apart from one nudge. The member's "Yes." (113.1) and "Yes." (170.4) got no answer and the shoot sat on shot 4 for over a minute. Earlier it also sent `mark start` twice in a row (73.05, 73.74) and `mark end` five times for one attempt (80.8-83.2). Every `end` after the first should be refused, not "done" | s6.json tool log; UAT1-15 |
| False takes from Director's own voice | Again: `mark start` for shot 1's line at 73.05, while Director itself was talking (the member's line came at 85.7) | UAT1-07 |
| Attempts on lines | Shot 1 line → praised and moved on (reply 0.59 s); shot 2 line → "perfect demo", moved on (0.26 s). When Director doesn't run tools first, it answers fast | |
| **Video saved by about 2:45** | **FAIL: can't save at all.** Done → editor in 6.3 s (about 2:30 wall clock), but **Save video stays disabled** because 6 shots are unfilmed ("6 shots still to film."; `canSave = every clip cut`). Nothing says why it's disabled or what to do; the wrap card says "tap Next" and there's no Next. The three-minute promise can't be met on any template with more shots than the member films (gap filling is #36, not deployed) | `42-s7-editor.png`; UAT1-16 |
| Post visible by 3:00 | FAIL (blocked by the above) | |
| Second phone, demo, sees none of the first one's footage | Not run (one guest per browser profile here). Guests are separate orgs, so expected PASS | |
| **"Couldn't review" takes in a clean session** | **3 of 5 takes**: shot 1 take 1, shot 2 takes 1 and 2 "Director couldn't review this take. Record it again." (U6 reproduces; this guest's footage was not touched by the controller) | editor text |
| Reviews say outdoors (U5) | "try filming outdoors in a busy street setting as intended" (shot 1), "try filming outdoors on a street next time" (shot 4), while Director itself told the member to skip because "you're indoors" | |
| Short takes (U8) | Shot 4 "Demonstrating Variation 2" chosen take 0.8 s | |

## Sessions 7 and 8: finishing the shoot, slice 4 (memory and re-planning), and the saved video (guest 2)

Session 7 (about 2 min): started on shot 5 and walked shots 5-10, saying the lines for 6, 8 and 10 and gesturing on the others. Director marked takes for 6, 9 and 10 only; 5, 7 and 8 stayed "Not filmed yet", so Save stayed disabled. Session 8 (about 2 min) was slice 4 plus another try at 5, 7 and 8. Events in `events.jsonl`.

| Check (slice 4) | Result | Evidence |
|---|---|---|
| "I'm switching indoors, I'll shoot everything at home" → card changes with "changed for you" | PASS for the card: Where "Indoors in the same spot", Do, Say, Framing all "changed for you"; an "Inside" chip | `49-s8-after-indoors.png` |
| **The shot doesn't jump after the plan change (U4)** | **FAIL, U4 reproduces**: the member was on shot 5 (`shot=4`); after the re-plan the screen moved to shot 6 (`shot=5`) by itself | URL before/after |
| All later shots indoors (U1) | **Partial**: shots 6, 8, 10 changed to indoors, but shot 5 still said "Along the street and inside local shops… people passing by" and shot 7 "Inside a clothing shop and a lobby… people indoors smiling" until "one angle" turned them into gaps | card text at 44.8 s and 58.9 s |
| "one angle is fine, I don't want other angles" → one-line confirmation and chip | PASS: "Totally, one angle it is! Done, everything's from right here now; I'll fill the other angles in the edit." and a "One angle" chip; shots 5, 7, 9 became gaps ("◇ a gap, not filmed" in the editor) | `50-s8-after-oneangle.png` |
| **After a reload Director still knows both, and the market is never mentioned again** | **FAIL**: after reload and Start, the first line was "Hey, we're on the last one! **Are you back in the market for this outro?**" The chips were intact (3 minutes, Inside, One angle) and the card still said Indoors (B5 family: Director doesn't get the version at socket open) | `52-s8-after-reload.png` |
| Remove a chip → acknowledgement | PASS: removed "3 minutes" → "Got it, no rush on time then. Whenever you're ready, just go for it, I'll be quiet." | `53-s8-chip-removed.png` |
| Reload lands on | shot 10 (fine) | |
| Skip a shot | covered in session 6 (Director skipped shot 3 on its own; the editor lists it "skipped") | |

### Editor after session 8, and Save

- **Save video stayed disabled with no explanation even though every shot was filmed, gapped or skipped.** Cause, found by downloading the takes: **shot 2's Director's-pick take is an empty MP4 (261 bytes, no streams)**, and so is shot 10's take 2. Both are the takes labelled "Director couldn't review this take. Record it again." The editor waits for every picked take to load (`ready = complete && every clip loaded`), so one empty take blocks Save forever and the member is never told. Picking shot 2's take 1 enabled Save at once. Two findings: the clipper/recording emits empty takes, which also explains U6's "couldn't review" (there's nothing to review); and Director's pick can be an unplayable take. See UAT1-17.
- Takes downloaded (`scratchpad/uat/takes/`): durations 0.25 s, 0.80 s, 1.13 s, 1.87 s, 7.10 s, plus the empty one. Only the 7.1 s one has the member's voice (max 0.0 dB); the others are silent (max -62 dB). Shot 8's 7.4 s line was said in full (about 9 s of speech) yet its take is 1.5 s and silent: **the cut doesn't contain the speech** (U8 reproduces, and slice 3's "each starting at the first word" fails).
- Console during the roll: `When using "avc1" for mp4 encoding, the codec description is not supposed to change during the entire recording. Normally, a change in the encoding resolution may lead to this situation.` (twice, once per shoot start). The roll's MediaRecorder sees a resolution change mid-recording, which can corrupt the part's MP4 (a candidate cause of the empty or broken takes and of U7's frozen frames). UAT1-18.

### Save (render 1 of 2) and the saved video

- Save: progress "Putting your video together… 84%" at 3 s, 99% at 5 s, "Saving to My media…" at 7 s, back to the editor at 14 s. There was no "Saved" confirmation and no link to the post; the member has to find My media themselves (UAT1-19). Progress started at 84% because the playhead was at 00:13 when Save was tapped.
- My media: the card says **00:14**; the file is **4.74 s** (video 4.739 s, audio 4.730 s, h264 720×1280 + AAC, fragmented MP4). The saved video is a third the length of the edit the member previewed: the three "fill in the edit" gaps aren't in it, nor is the edit's own timing (UAT1-20).
- A/V sync and frames (ffprobe packets): 142 video frames, no frame-to-frame gap over 100 ms (no frozen-frame jump like U7's 10.4 s), audio and video start at 0 and end within 9 ms. PASS on sync for this short file.
- **The saved video's audio is silent for its whole 4.73 s** (silencedetect -40 dB: one silence 0 → 4.73). The member's lines aren't in their own Short, because the picked takes are the silent cuts above (UAT1-17/UAT1-21).
- Captions burned in: yes, each shot's script line in white with one red-highlighted word (frames at 0.3, 1.5, 3, 4.5 s, `scratchpad/uat/saved1-strip.png`). **The captions are the script, not what the member said, and run over silent footage** (shot 8's long caption over a 1.5 s silent clip).
- My media poster: blurred frame of the *original creator* (the template), not the member's video (`58-my-media.png`). Minor (UAT1-22).
- "See the post Director wrote" (publish sheet, opened, not published): "Posting is off for the demo. Sign in with Google to post your own." Title, description, hashtags, credits "Inspired by Living the Jo Life and recreated with Director." It opens as a centred dialog, not a bottom sheet with a grabber (quality bar). Its video preview showed a dark spinner on a dark tile when the screenshot was taken. `60-publish-sheet.png`.

### Editor (v1.6.0) notes

- The tell-Director bar, trims and gap filling (#35, #36) are **not in production v1.6.0**, so slices 8 and 14 can't be run there. The editor has take arrows, undo/redo, captions and sound toggles, Retake and Film it.
- Take swap: one tap on "Previous take" swaps (PASS), and Undo puts it back (PASS). After the swap the review text shown is still the other take's ("Great, natural delivery…" over a take Director couldn't review) (UAT1-23).
- Playback: plays and the clock advances 1 s per s (PASS).
- Tap targets under 44 px in the editor: Back, Play, Captions, Sound, Undo, Redo 40×40; Previous/Next take 36×36; Retake 85×29 and 48×24; Film it 60×28 (UAT1-24).

## Slice 15: create from scratch (guest 2, phone; no Live session, shooting not run because the Live budget was spent)

| Check | Result | Evidence |
|---|---|---|
| Describe "20 seconds of my morning coffee, cosy, no talking" + two photos | PASS: both photos uploaded with thumbnails and ×; "Only upload photos you have the right to use" shown once | `62-create-filled.png`, `63-create-talk.png` |
| Talk it through | First question in about 4 s; each answer answered in 4-7 s. **Three questions (PASS ≤ 3)**: brew method, on camera or hands only, ASMR or song. Then "Say less, I've got everything I need! Ready to write your shots now." Answers were typed: the voice button uses browser dictation, which this harness can't feed | `64-create-conversation.png` |
| Write my shots | "Director is writing your shots. This takes about a minute. You can leave this page, it keeps going." The plan was ready in about 12 s: "Window Morning Pour-Over", 4 shots, 4+5+5+6 s = 20 s, hands and mug, no talking | `65-created-plan.png` |
| Edit one shot, delete another | Works, but **edits aren't autosaved**: the button changes to "Save changes", and **reloading or navigating away silently discards the edits with no "unsaved changes" prompt** (tested both). After "Save changes" → "Saved", the edits survive a reload | UAT1-25 |
| The created template page | **FAIL (copy)**: "What you'll need: **You, talking to the camera**" for a brief that says "no talking, just hands and the mug". Each shot also says "Back camera" (consistent with hands only). The storyboard reads "Director is still drawing this shot" while it renders | `67-created-template.png`; UAT1-26 |
| Director knows "no talking" when shooting | **not run** (no Live budget left) | |

## Slices 9 and 10: asset Shorts and the asset picker (guest 1, no Live)

- OvRozQobeuI and IFBBmwsGpUw are not seeded ("This Short isn't in your library yet."). I indexed OvRozQobeuI as guest 1 (the account's one own Short): "Gemini is watching the Short", Queued → Watching → Writing shots → Ready in about 60 s. PASS for indexing.
- **FAIL: the indexed plan has no asset slot.** "What you'll need" lists only "You, talking to the camera / About 3 minutes"; there's no chart slot, so the asset picker (rendered only from `plan.assets`) can't be opened. Slice 9's chart guide and the whole of slice 10 can't be reached on a Short a member brings. The plan knows the chart is there: shot 1's framing says "so the bottom two-thirds stays open for your chart". UAT1-34. `69-asset-template.png`.
- Shot 2 "Quiz Call to Action Card" (a photo shot) lists the end card's on-screen text as **Lines** to say: "TestLibrary Archetype Test. Gain a clearer understanding of yourself… Start by selecting your gender: Male, Female. Take a test." (UAT1-34).
- "The original audio couldn't be fetched, so your mic will be used." shown on the template. Fine as copy.
- Slice 9 shooting (chart guide in the bottom half, voice-over full-screen image) and saving: **not run**, with no slot and no Live budget left.

## Desktop 1440×900 (guest 2)

- No horizontal scroll on library, template, editor, shoot, media (scrollWidth 1440). `71`–`75-desktop-*.png`.
- Editor: two panes (preview left, shot board right). PASS for the layout rule. But the shot board's columns have uneven widths (shot 4's column about 110 px, review text a few words per line), the last column (shot 8) is **cut off at the right edge** with no visible scroll affordance, and two "Retake" labels float loose at the bottom of the board under the columns. The preview showed only the burned caption over a dark frame at 00:00. `73-desktop-editor.png` (UAT1-35).
- After reloading the editor, my take choice for shot 2 was back to Director's pick (the empty take), and Save was disabled again: choices aren't kept (known F11). Combined with UAT1-17, a member who fixes Save by picking another take loses the fix on reload.
- Shoot start card on desktop: centred card and button, black above (no camera until the tap): fine. `74-desktop-shoot-start.png`.

## Accessibility (axe-core 4, WCAG 2.2 AA rules, desktop)

| Page | Violations |
|---|---|
| Editor | color-contrast (serious) ×4: the red "Director couldn't review this take. Record it again." text #b55c5b on #101010 = 4.21:1 (needs 4.5:1) (UAT1-36) |
| Shoot start card | none |
| Created plan (/create/…) | none |
| My media | none |

Screen-reader names checked from the accessibility tree: shoot controls have names ("Pause recording", "Shot N: to do. Go there", "Leave the shoot", "Flip the camera", "Done", "Tell Director"); captions are mirrored into an aria-live "Director says …" line (PASS). Editor take radios are labelled with their review status (PASS).

## Known issues: reproduction status

| Known | Reproduces? | Evidence from this run |
|---|---|---|
| U1 "switching indoors" changed only shot 1 | **Partly**: shots 6, 8, 10 changed; shots 5 and 7 kept street or shop "real examples" until "one angle" gapped them | session 8 |
| U2 captions late | **Yes**: first words 0.17-1.86 s after the voice (median about 0.7 s), though the transcript arrives 0.2-0.3 s *before* the audio, so the lag is on the client side (React state per chunk and render), not Gemini | sessions 2, 3, 4 |
| U3 Director stops mid-turn, replies very late | **Late replies: yes** (2.6-7.1 s whenever tools run first; some turns never answered, UAT1-31). Mid-turn stops: every `interrupted` I logged lined up with the member's own (fake) speech, so I saw no spurious stops. Turns did get cut by the relay's own tool calls ("Sounds good," then silence in session 4) | sessions 4, 6 |
| U4 shot jumps after a plan change | **Yes**: shot 5 → 6 after "I'm switching indoors" (session 8); `go_to_shot` right after `replan` in sessions 2 and 6 | |
| U5 reviews say outdoors; titles "in the Market" | **Yes**, in every editor (shot 1, 2, 3, 4, 8, 10 reviews) | |
| U6 "couldn't review" | **Yes**, and the cause is visible: the takes are empty 261-byte MP4s (UAT1-17) | session 6/8 editor |
| U7 exported Short broken | Not reproduced in the same form (no frozen frame; A/V aligned to 9 ms on a 4.7 s file), but the saved video is silent and a third of the edit's length (UAT1-20, UAT1-21) | saved-1.mp4 |
| U8 takes of 0.1-1 s | **Yes**: 0.25 s, 0.8 s, 0.9 s, 1.13 s, 1.5 s takes; a 7.4 s line cut to 1.5 s of silence | takes/ |
| B5 messages at socket open lost | **Yes**: Director's first line ignores the sent version 3 times ("film outside like the shot says?", "busy market street?", "back in the market for this outro?") | sessions 3, 4, 8 |
| L4/L7 reconnects | No drops seen in 8 sessions (all closes were 1005 on leaving) | |

---

# Issue list

Severity: blocker / major / minor / polish. "Known" marks issues already tracked in uat-open-issues.md or findings.md, where this run adds evidence. Code paths are at tag v1.6.0 (3c9493c5).

### UAT1-15 · blocker · functional · Director gets stuck in a `mark end` loop and goes silent
- Where: /director/22k0fZarxh8/shoot (roll mode), Live relay tools.
- Steps: fresh guest → head-nod → Start → "I've only got three minutes" → say shot 1 and 2 lines → on shot 4 say "yes".
- Expected: one `mark end` per attempt; Director keeps talking with the member.
- Actual: about 60 `mark {event:"end", note:"explained the topic well"}` calls, one every 0.8-1.7 s for 90 s, each answered `done`. Director said nothing for 60 s apart from one nudge, ignored two "Yes." turns, and the shoot sat on shot 4. Earlier, two `mark start` in a row and five `mark end` for one attempt.
- Evidence: `scratchpad/uat/s6.json` (tool log 104-193 s); session 6 table.
- Suspected: the relay's `mark` handler in apps/api (Live tools) answers `done` to an `end` with no open attempt, and to a duplicate `start`; it should answer something like `no_open_attempt` so Gemini stops. Also cap repeated identical tool calls per turn.

### UAT1-07 · blocker · functional · Director marks takes that never happened and misses real ones
- Where: shoot, roll mode.
- Steps / actual (four sessions):
  1. Member says "Hi, yes I'm ready, let's do it" → `mark start/end` as shot 1's line, "Said the line clearly", "That was great… move on", `go_to_shot 1` (session 2).
  2. Member types "can you say my line again?" → Director reads the line, then marks *its own reading* as the member's attempt and praises it (session 3).
  3. "go / ready / start / action / record" → `mark start` for shot 2's line with no end (session 2).
  4. With the member idle, it marks shots 3 and 4 ("good clear nod", "nailed the quick nod") and moves on twice (session 4).
  5. The member's real reworded attempt got no mark, just a nudge (session 3); in session 7 three real attempts (shots 5, 7, 8) got no take.
- Expected: an attempt is marked only for the member's own try at the shot; Director's voice never counts.
- Evidence: s2.json, s3.json, s4.json tool logs.
- Suspected: Live system prompt and the `mark` tool contract (apps/api live relay / prompt); nothing server-side checks that the member was speaking (the input transcript) between start and end.

### UAT1-17 · blocker · functional · Empty take files: "couldn't review", Save blocked forever, Director's pick unplayable
- Where: editor /director/22k0fZarxh8/edit (guest 2, clean footage).
- Steps: shoot shots via Live roll → Done → editor.
- Expected: every take plays; Save enables when every shot is filmed, gapped or skipped.
- Actual: shot 2's Director's pick and shot 10's take 2 are **261-byte MP4s with no streams**. These are exactly the "Director couldn't review this take" takes (so U6's root cause is upstream of the review). The editor waits for every picked take to load (`ready = complete(clips) && clips.every(loadedTake)`), so Save stays disabled with no message. Swapping shot 2 to take 1 enabled Save; reloading put the broken pick back. The other takes are 0.25-1.9 s and silent, except one 7.1 s take; a 9 s spoken line became a 1.5 s silent take.
- Evidence: `scratchpad/uat/takes/*` (ffprobe), sessions 7-8 notes, `57-editor-save-disabled-full.png`.
- Suspected: the clipper (apps/ai session recordings / clipper) writing empty outputs and the API storing them as takes; the attempt windows from `mark` don't match where the speech is (UAT1-07). Web: edit.tsx should flag a take that won't load ("This take didn't save. Pick another or retake") instead of silently disabling Save; never pick an unplayable take.

### UAT1-16 · major · functional/UX · The three-minute path can't save: Save stays disabled while any shot is unfilmed
- Where: editor after a Quick start shoot.
- Steps: slice 7: "I've only got three minutes", film what Director picks, Done.
- Expected: video saved by about 2:45 (gaps filled or the cut shortened).
- Actual: Director's "3 minutes" replan only skipped one shot; 6 shots stayed "Not filmed yet"; Save video is disabled with only "6 shots still to film." above the board. Nothing tells the member why, or that "Film it" is the way on. The wrap card says "tap Next". There's no Next.
- Evidence: `42-s7-editor.png`; `complete()` in lib/edit.ts.
- Note: gap filling is #36 (not deployed); the three-minute replan should also turn the shots it drops into gaps or skips.

### UAT1-20 · major · functional · The saved video is a third of the edit's length
- Where: Save video → My media.
- Actual: the editor and the My media card say 00:14; the saved file is 4.74 s (the gaps "filled in the edit" are missing). Progress began at 84% because the playhead was at 00:13 when Save was tapped.
- Evidence: `scratchpad/uat/saved-1.mp4` (ffprobe), `56-render-done.png`, `58-my-media.png`.
- Suspected: lib/stitch.ts (render length and gap segments) and the My media duration taken from the edit rather than the file.

### UAT1-21 · major · functional · The saved video has no voice
- Actual: silencedetect at -40 dB finds one silence covering the whole 4.73 s. The member's spoken lines aren't in their Short, because the picked takes are silent cuts (UAT1-17). Script captions are burned over silent clips.
- Evidence: saved-1.mp4, `saved1-strip.png`.

### UAT1-11 · major · UI · On a phone, the roll's top bar pushes ✕ (Leave) off-screen
- Where: shoot screen, roll mode, 390×844.
- Actual: REC pill, pause (36×36), then ten shot dots (28×28) in one row: dots 8-10 at x 395-483 and "Leave the shoot" at x 610, all past the 390 px edge. There's no visible way to leave except Done or the system back. With 11+ shots it gets worse.
- Expected: everything on screen; targets ≥ 44 px (48 dp).
- Evidence: geometry dump in session 3; `21-s2-roll-ui.png`, `23-s3-topbar.png`.
- Suspected: components/roll-parts.tsx (RollProgress) and the Overlay top row in pages/shoot.tsx: let the dots scroll or collapse ("3/10"), keep ✕ pinned.

### UAT1-27 · major · UX · ✕ during the roll leaves with no confirmation
- Steps: roll recording (REC 01:24) → tap ✕.
- Expected: "Leave?" with Stay / Leave (slice 1 step 9 and back gesture).
- Actual: goes straight to the template page; the session is finished (`done`, 85 s). Back returns to a fresh Start card. The same happened on the shared-demo shutter mode.
- Suspected: pages/shoot.tsx `useLeaveGuard({ guarded: studio.phase !== "setup" })`. In roll mode the studio phase stays "setup" while the roll records, so the guard is never armed.

### UAT1-12 · major · functional · Closing the tab or navigating away leaves the session "recording" forever; reopening starts a new one
- Steps: roll recording → close the tab (or navigate away) → reopen the shoot.
- Expected (slice 3): reopening finishes the upload and the session; Done leads to the editor with those takes.
- Actual: plain Start card, no leftover message; Start creates a new session. GET /rpc/recording/sessions shows 01a15125 (tab closed) and 01a15121 (navigated away) still `recording`, `finishedAt: null`, 171 s each.
- Suspected: hooks/use-roll-shoot.ts, use-roll.ts (no finish on pagehide/unmount; no resume of an open session on start); the API's `start` should return the open session for the same video.

### UAT1-05 · major · UX · Shared demo account: the start card promises continuous recording, then silently falls back to the shutter
- Steps: sign in with the shared demo account → Let's shoot → Start shooting.
- Actual: `POST /rpc/recording/start` → 403 (DEMO_ACCOUNT_LOCKED by design); the screen shows the red shutter with no REC, Pause or Done. The card had said "Director records the whole time you're shooting, chat included…". No notice explains that takes now need the shutter.
- Suspected: pages/shoot.tsx `rollOn = liveOn && MediaRecorder` ignores the account; StartCard copy (intro.rollFirst).

### UAT1-06 · major · performance · "Start shooting" to Director's first word misses the 2.5 s target
- Measured: 7.32, 4.58, 2.38, 2.10, about 7 s (S2, S3, S4, S6, S8) → median 4.6 s, worst 7.3 s (target 2.5 s median, 4 s worst).
- Breakdown (S2): **a 3757 ms main-thread long task began 50 ms after the tap**, before getUserMedia; then 1.1 s to the socket, 1.5 s to open, 1.0 s to audio. In S3, no long task, but **the relay took 3.0 s to accept the WebSocket**.
- Evidence: s2.json longtask entry; `start-tap.cpuprofile` (S3, idle).
- Suspected: the relay waits for Gemini setupComplete before accepting (could accept at once and buffer); the long task needs a trace on a phone.

### UAT1-29 · major · performance · Replies take 2.6-7 s whenever Director calls tools first
- Measured (member stops → Director's voice): 1.03, 1.55, 1.44, 0.59, 0.26 s when no tool runs; 4.24, 4.20, 4.31, 6.1, 6.2, 6.9, 7.1 s when `remember`/`replan`/`mark`/`go_to_shot`/`adapt_shot` run first. Target 0.8 s median / 1.5 s worst.
- Suspected: the Live prompt makes Director call tools before speaking; an acknowledgement could go first ("Got it, one sec").

### UAT1-31 · major · functional · Some member turns never get an answer
- "Okay, I'm going." (S3: 16.7 s silence), "Wait wait." (S4: 17.9 s, then a nudge), "Actually, use the second one." (S4: unrelated reply about earphones, no pick), "Yes." ×2 (S6, during UAT1-15).
- Expected: every turn answered (quality bar), and the pick honoured (slice 5).

### UAT1-28 · major · functional · Director re-asks for the outdoors/market the member already declined (known B5/U5 family)
- S3: "Are you planning to film outside like the shot says?"; S4: "Is that a busy market street you're in?… can you find a spot outside?" and "we could switch to the back camera" for the market background; S8 after reload: "Are you back in the market for this outro?" Each time the version with Kitchen/Inside was sent in `context` at socket open.

### UAT1-34 · major · functional · A member-indexed asset Short gets no asset slot, so slices 9 and 10 can't be reached
- Where: /director/OvRozQobeuI after indexing as a guest.
- Actual: no chart slot in "What you'll need" (so no asset picker); shot 1's framing mentions "your chart". Shot 2's Lines are the end card's on-screen text ("TestLibrary Archetype Test… Start by selecting your gender: Male, Female. Take a test.").
- Suspected: the indexer's asset detection (apps/ai) for non-seed Shorts; on-screen text classified as speech.

### UAT1-09 · major · UI · Captions lag Director's voice by 0.2-1.9 s (known U2, new detail)
- Measured first-words lag: S2 0.43-1.03 s; S3 0.17-1.86 s; S4 0.22-1.68 s (median about 0.7 s). The transcript text reached the browser 0.2-0.3 s **before** the audio played in every turn, so the delay is in the client (caption state update and animation), not Gemini.
- Suspected: hooks/use-director-live.ts `setCaptions` per transcript chunk and components/director-captions.tsx; schedule captions against `play` times (F13 covers part of this).

### UAT1-18 · major · functional · Roll recorder warns the MP4 codec description changed mid-recording
- Console on every roll start: `When using "avc1" for mp4 encoding, the codec description is not supposed to change during the entire recording. Normally, a change in the encoding resolution may lead to this situation.`
- Likely cause of broken parts and empty takes (UAT1-17) and possibly U7's frozen frames.
- Suspected: lib/roll.ts / hooks/use-roll.ts start MediaRecorder before the camera's resolution settles (ideal 1080×1920 vs 720×1280 delivered), or after a flip without a new part.

### UAT1-30 · minor · performance · Barge-in stops Director after 0.72 s (target 0.3 s)
- Member starts "wait, wait" 13.889 s → `interrupted` 14.610 → audio flushed 14.611. The client flushes at once; the delay is relay or Gemini VAD.

### UAT1-08 · minor · UX · Quiet nudge fires over the member; caption sentences glued with no space
- "Still with me? No rush." started at 32.79 while the member was mid-line (ended 33.10), and 3 s after the member's reworded line (S3). Captions: "No rush.That was great", "you're in?You'll want", "Moving on.This one's".
- Suspected: the nudge timer ignores the input transcript (L8 is related); lib/live.ts `withTranscript` concatenates generations without a separator.

### UAT1-14 · minor · UI · Phone editor shot board squeezes shot columns
- Editor at 390 px: shot 1's column is about 120 px, "Intro i…" truncated, "Take 3 of 4" wraps, the review note runs 1-2 words per line. `37-s5-editor.png`.

### UAT1-35 · minor · UI · Desktop editor board clipped, stray "Retake" labels
- 1440×900: the last column is cut at the right edge with no scroll hint; two "Retake" labels float under the columns; column widths vary from about 110 to 330 px. `73-desktop-editor.png`.

### UAT1-25 · minor · UX · Create: shot edits aren't autosaved and leaving discards them without asking
- /create/<id>: edit "What happens" and delete a shot → the button becomes "Save changes"; reload or navigate away → edits gone, no prompt. After "Save changes" they persist.

### UAT1-26 · minor · copy · Created template says "You, talking to the camera" for a no-talking brief
- Brief "no talking, just hands and the mug" → template "What you'll need: You, talking to the camera". `67-created-template.png`. Suspected lib/needs.ts default.

### UAT1-33 · minor · UX · Quick start isn't quick on a phone
- It sits below the fold on /library (y ≈ 780 of 844) and opens the template page, not the shoot; the member still has to find "Let's shoot" (and pick "I'll speak").

### UAT1-19 · minor · UX · No confirmation after Save
- After "Saving to My media…" the editor returns to its normal state with Save video enabled again; no "Saved", no link to My media or the post.

### UAT1-13 · minor · copy · Wrap card says "tap Next"; the button is "Save video"
- "I cut your takes together, best moments first. Make any last changes, then tap Next." Also first person "I" (the quality bar asks for second person in UI copy).

### UAT1-23 · minor · UX · Review note doesn't follow the selected take
- Shot 1: switching to take 1 (couldn't review) still shows take 2's note "Great, natural delivery of the line…".

### UAT1-32 · minor · functional · "Grandma" change overwrote an unrelated row
- "what if I do this one with my grandma instead" → `adapt_shot` also set Where from "Kitchen" to "Inside" and camera to back.

### UAT1-24 · minor · a11y · Editor and shoot tap targets under 44 px
- Editor: Back/Play/Captions/Sound/Undo/Redo 40×40; take arrows 36×36; Retake 85×29 and 48×24; Film it 60×28. Shoot: pause 36×36, shot dots 28×28.

### UAT1-36 · minor · a11y · "Director couldn't review this take" red text fails contrast
- axe: #b55c5b on #101010 = 4.21:1 (needs 4.5:1), 4 nodes on the editor.

### UAT1-02 · minor · functional · Sign-in page CSP blocks Turnstile's `data:` probe (needs a phone check)
- Console on /sign-in?demo=1: `Fetch API cannot load data:,. Refused to connect because it violates the document's Content Security Policy` (connect-src). The guest demo failed for the automated browser and worked for a non-automated one, so production members likely aren't blocked. If Cloudflare scores the blocked probe, some real phones could fall back to the shared account. Suggest adding `data:` to connect-src for the Turnstile probe, or confirming with Cloudflare's CSP guidance.

### UAT1-03 · minor · copy · Contradictory sign-in alerts when the guest demo can't start
- Both "Your own demo couldn't start just now…" and, in red, "The security check couldn't load. Check your connection, allow challenges.cloudflare.com…", while the Turnstile widget is visibly loaded ("Verify you are human" / "Verification failed").

### UAT1-22 · polish · UI · My media poster shows the original creator, not the member's video
- `58-my-media.png`: blurred frame of the template's creator behind the play button on the member's own saved video.

### UAT1-37 · polish · UI · "The post Director wrote" is a centred dialog, and its preview showed a dark-on-dark spinner
- The quality bar asks for a bottom sheet with a grabber, swipe to dismiss. `60-publish-sheet.png`.

### UAT1-10 · polish · tone · Director says "plan"
- "OK, the plan's updated – we'll do all the shots in the kitchen now."; "I've replanned the remaining shots". The quality bar bans "plan".

### UAT1-04 · polish · copy · "Try it now" lands on "Welcome back / Sign in with your email and password."

### UAT1-01 · polish · UI · Landing hero: "REC 01:12" pill wraps onto two lines at 390 px
- `01-landing-phone.png`.

### UAT1-38 · polish · UI · Template page metadata overlaps the YouTube player's own title and Share overlay
- `05-template-headnod.png`: "Travel Observation / Cultural Vlog · 00:36 · 10 shots" sits over the embed's "4 Types of Indian Head Nods #shorts" and "Share".

---

# Summary

Production v1.6.0, phone profile (390×844) plus a desktop pass. 8 Live sessions (about 16 min of Gemini Live in total, each under 3 min), 1 save/render, 1 Short indexed, 1 create-from-scratch plan. Harness: Playwright-driven Chrome with fake camera and an injected, scriptable microphone; every relay message, audio chunk and caption change timestamped.

Counts (new UAT1 issues): **blocker 3, major 14, minor 15, polish 6** (38 total). Known issues reproduced: U1 (partly), U2, U3 (late replies), U4, U5, U6 (root cause found: empty take files), U8, B5. U7 didn't reproduce in its old form, but the saved video is silent and a third of the edit's length.

Not run: slice 6 (needs engineering to switch Live off), slice 9 and 10 shooting and the picker (no asset slot, UAT1-34), the slice 14 editor and slice 8 (not deployed in v1.6.0), the "no talking" check of slice 15 and the second-phone check of slice 7 (Live budget). Rerun: slice 5's editor order and slice 3's take counts. The editor for guest 1 mixes takes from the two sessions whose slices the controller deleted, so those were judged only from the clean guest 2.

Top 10:
1. UAT1-15 (blocker): Director loops `mark end` about 60 times and goes silent for a minute.
2. UAT1-07 (blocker): false takes. Director marks its own voice, "hi", "start action record" and idle footage as attempts, and misses real ones.
3. UAT1-17 (blocker): empty 261-byte take files cause "couldn't review" (U6), can be Director's pick, and silently disable Save.
4. UAT1-21 / UAT1-20 (major): the saved video is silent and 4.7 s for a 14 s edit.
5. UAT1-16 (major): the three-minute path can't save; Save is disabled with no reason while shots are unfilmed.
6. UAT1-11 (major): at phone width the roll's top bar pushes ✕ (Leave) and the last shot dots off-screen.
7. UAT1-27 / UAT1-12 (major): ✕ leaves mid-recording with no dialog; closing the tab leaves the session "recording" forever and reopening starts a new one.
8. UAT1-06 / UAT1-29 (major): first word 2.1-7.3 s (median 4.6 s); replies 4-7 s whenever Director calls tools first.
9. UAT1-28 / U4 / U5 (major): Director and the reviews keep pushing the market or outdoors after the member chose indoors, including right after a reload; the shot still jumps after a re-plan.
10. UAT1-09 (major, U2): captions trail the voice by up to 1.9 s although the text arrives before the audio, so the fix is client-side.
