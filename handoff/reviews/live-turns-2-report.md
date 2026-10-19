# Live turns 2: report (UAT run 1)

Branch `fix/mm/live-turns-2`, rebased on master `2da247f` (#39, #40), head `203c6dc4`,
pushed with `--force-with-lease`. The one rebase conflict (the `adapt_shot` description
in `live.setup.ts`) keeps master's new title clause and this branch's "only the rows this
change touches". UAT ran on v1.6.0, before #38; for each item I say what #38 already
covers and what this branch adds. Each fix here started with a test that failed first.

## Fixed on this branch

**UAT1-15, the `mark end` loop (blocker).** Cause: the browser numbers attempts and never
forgets the last one, and the API answers an end for an attempt that's already ended by
returning that attempt, so every repeat came back `done`. Gemini kept getting "done"
with nothing open and kept calling. The relay now tracks whether an attempt is open
(open once the browser answers `done` to a start, closed at an end, a pause, Done or the
attempt deadline). It refuses at once, without reaching the browser, an end with nothing
open ("No attempt is open… Don't mark it again. Give your note now") and a start while
one is open. Separately, any tool called more than 5 times in 10 s is refused ("You've
called this over and over. Stop calling it and talk to them") and logged at warn as
`live tool called over and over {tool}`. Code: `live.guards.ts`, `live.relay.ts`.
Tests: "Director's marks on the roll, kept honest" in `live.test.ts`, `live.guards.test.ts`.

**UAT1-07, false marks (blocker).** The relay refuses a `mark start` in a turn where
Director's own voice has already come in ("You were talking: an attempt is theirs, never
your own words…"), which covers Director marking its own reading of the line. Persona v6:
- an attempt starts only when the member begins the shot's own action or line after a
  go cue;
- "Hi", "I'm ready", "let's do it", "start, action, record", chat, mumbles and idle
  footage never count, and nor does Director's own voice;
- mark start without a word, mark end once, never start another while one is open, and
  stop calling when a mark is refused;
- if unsure, don't mark, ask.

The `mark` tool description says the same. Not done: the relay can't tell a real attempt
it missed, so misses (UAT step 5) are prompt-only. A server check that the member was
heard between start and end isn't possible for silent actions like a nod.

**UAT1-08, the nudge over the member.** The relay now counts the member's voice on the
microphone (100 ms chunks louder than about -30 dBFS) as heard, so the 15 s quiet clock
restarts as soon as they talk, before Gemini's transcript arrives. #38 already holds a
nudge while a turn is under way. **Glued sentences:** captions put a space after a full
stop, question or exclamation mark when a lower-case word is followed by a capital
("No rush.That" becomes "No rush. That"). "U.S." and "2.5" stay as they are.
(`lib/live.ts`)

**UAT1-06, slow start.** In the browser, the socket to the relay used to open only once
the microphone was granted, so the permission prompt and the mic start sat in front of
Director's first word. It now opens at once and the microphone joins the line whenever
it's ready (`lib/live-session.ts`). In the API, Google's token is fetched beside the plan,
not after it. The start is logged in three steps, so production shows where the time
goes: `live call checked {ms}` (sign-in, plan, call limit), `live call ready {msToReady}`
(Gemini's setup) and `live first voice {msToVoice}`.
- Not fixed: the 3.8 s long task after the tap. It needs a trace on a phone, and the
  camera, roll and AudioContext start belong to the web fixer's files.
- Not fixed: UAT S3's 3.0 s for the WebSocket to open. The API accepts the upgrade
  without awaiting anything, so that time is network or ingress.

**UAT1-29, slow replies after tools.** Persona v6 says: speak before you act. Before
remember, adapt_shot, replan, go_to_shot or switch_camera, Director says its few words
first ("Got it, one sec."), then calls the tool; mark is the exception. The browser
already answers every tool except replan and point_at at once. #38 already shows "re-planning" while a replan
runs.

**UAT1-10, "plan".** The persona now bans "plan" and "replan" by name, with words to use
instead ("your shots", "your video").

**UAT1-32, the grandma change.** Gemini sent `where` and `camera` along with the person,
and nothing on our side can tell an unasked row from an asked one. The `adapt_shot`
description and the persona now say to send only the rows the change touches. #38
already stops a later change wiping an earlier one.

## Covered by #38, not changed here

- **UAT1-31, unanswered turns.**
  - "Actually, use the second one" got an earphones reply. That's the noise note
    ("suggest typing or earphones") sent mid-turn on v1.6.0; since #38 it waits until
    Director's reply ends and asks for no answer.
  - The two "Yes." turns were lost to the UAT1-15 loop.
  - "Wait wait." and "Okay, I'm going." got no reply from Gemini itself. The relay
    forwarded the audio, and nothing it held could have swallowed them. With proactive
    audio on (since #37), Gemini may choose not to answer; the persona says to answer
    everything. Worth turning `LIVE_PROACTIVE_AUDIO` off if this repeats on the current
    build.
- **UAT1-28, market re-asked.** v1.6.0 dropped the version sent at socket open; #38 keeps
  it (the relay test "keeps what the browser says as its socket opens"). What's left is
  the shot title ("Intro in the Market") in Director's brief; master's #39/#40 title
  work covers it if it set titles on the member's version.
- **UAT1-09, captions behind the voice.** v1.6.0 set React state for every chunk. #38
  moved captions to their own store and times words against the voice's queue. I can't
  measure the owner's phone from here; `directorLiveTimings()` in the remote inspector
  and the relay's `live turn` log (`captionLagMs`) give the numbers on the next UAT.
- **UAT1-30, barge-in after 0.72 s.** The browser flushed 1 ms after `interrupted` in the
  UAT log, so the time is Gemini's voice detection. #38 raised prefix padding to 400 ms
  to stop echo cutting Director off, which works against the 0.3 s target. Going below
  about 0.4 s means lowering it again, a trade-off for the owner to make. I left it.

## Checks

- `bun run check-types`: passes.
- Biome: passes (1 warning).
- Unit tests: api 380 and web 230 after the rebase.
- `test/director/director-live.test.tsx`: 29 of 30. The failure, "tells Director about a
  flip at once…" (`hook.current` undefined right after render), also failed once on the
  #38 branch and passes when the hook tests run alone. It looks like an existing
  order-dependent flake.
- Earlier runs had `/sign-up/email` answering 500 for a few tests. That's the shared test
  database under load; it passed on rerun.

## Not done / for others

- The relay could refuse a `mark end` that comes too soon after a start. Prompt only for
  now.
- The web fixer owns the shared AudioContext. I found what looks like a race: a screen
  unmount suspends it, a quick restart resumes it, and if the suspend lands second the
  microphone stays silent. It showed up as the order-dependent test above.

## After #44 (UI UAT items)

Head `bfd71ff2`, one commit on master `e9d1610`, on a recreated `fix/mm/live-turns-2`.

- **UI1-21, Director describes things that aren't there.** Persona v7: the shot is what
  the member wants to film, not what's in front of the camera, so Director never
  describes its place, people or props as if it saw them. It describes only what the
  frames show and says it can't make the picture out when it's dark, blank, a pattern
  or shows no person or place. It never praises a look, gesture or line it didn't see or
  hear.
- **UI1-22, three nudges in 25 s.** The relay sends at most two nudges a shot, each
  after 15 s of quiet. The extra "Still there?" lines were Director's own, answering the
  fake microphone's beeps. The persona now says to nudge only when the app's note says
  so, and not to answer sounds with no words in them. #44 also restarts the quiet clock
  when the member's microphone is loud. Prompt-only: the relay can't stop a line Gemini
  decides to say.
- Tests: `PERSONA_RULES` checks the new rules. The api live tests pass (147).
