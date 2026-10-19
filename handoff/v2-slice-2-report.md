# Director v2, slice 2: a two-way, flexible conversation (report)

Branch `feat/mm/director-v2`, pushed. Built on slice 1 plus its re-review fold-ins.

## What changed

- **Persona (6.15).** It now lives in its own versioned file,
  `apps/api/src/modules/live/live.persona.ts`, at `PERSONA_VERSION = 2`. It is made of:
  - who Director is: a friend helping you shoot a reel;
  - how it talks: one or two sentences, answers everything including "ok", and avoids banned words;
  - how the shoot works: never starts a take; silent from the 3-2-1 to the end of a take; speaks first after it; says the line when asked;
  - the flexibility rules: never corrects a rewording; goes with the member's version; uses `adapt_shot`; pushes back once; never re-suggests something declined;
  - the app's notes: quiet nudges and noise;
  - example dialogues in the spec's style.

  `live.test.ts` checks that 16 key rules are present in the setup Gemini receives, and checks the version.
- **Events (6.7)** live in `apps/api/src/modules/live/live.pacer.ts`, which the relay drives:
  - **Quiet:** 15 s with nothing said, typed or done on screen, outside a take, sends a "quiet" note. The first asks for one light nudge; the second says Director will wait. There is never a third on the same shot, and a new shot starts its own two. Nothing is sent from the countdown to the end of the take.
  - **Noise:** 3 interruptions inside 30 s send a note, once a shoot, suggesting the text box or earphones.
  - **Countdown called off:** this note now asks for an answer ("a few words to check they're all good"), so every event gets an answer.
- **Speech detection:**
  - start-of-speech sensitivity is LOW, so room noise or an "mm" doesn't cut Director off;
  - 200 ms prefix padding;
  - 700 ms of silence ends a turn;
  - barge-in is kept.
- **Silent during attempts, speaks after.** This was already in place from slice 1 (the hold and the take notes). I fixed a race in it, below.
- **The text box** is unchanged from slice 1. Typed lines reach the session as the member's own turn, and the pacer counts them as activity.
- **`adapt_shot` (minimal, my call; see Calls).**
  - **Contract** (`packages/contracts/src/live.ts`):
    - a `liveAdaptation` schema with `shot` plus `where` / `action` / `line`, each trimmed and 1 to 300 characters;
    - the tool call;
    - a `context` client message carrying the shoot's changes.
  - **Relay:**
    - validates the call: a shot the plan has, at least one change, within the bounds;
    - hands it to the browser;
    - keeps it only once the browser answers `done`, merged with earlier changes;
    - describes the member's version in the next connection's setup and in each move to that shot's brief;
    - on reconnect, takes the browser's `context` back. If it arrives after that connection's setup went, Director gets a version note before its greeting.
  - **Web:**
    - `lib/your-version.ts` builds the shot as the member has it: their place as the scene, their action as the first step (or the pose), and their line across the whole shot;
    - the card shows that version. Changed rows glow once (`live-changed`, off under reduced motion) and say "changed for you" (i18n);
    - the teleprompter and the take review use their line;
    - mid-take, a change is refused as `busy`;
    - a fresh connection sends every change first.
- **Mock Live stand-in** (`packages/fake-google/src/live.ts`) now pins this behaviour:
  - it keeps the brief of the shot it's on, from the setup and each move;
  - "say my line" reads that shot's line, or the member's own once they've changed it;
  - "what if I do it with my grandma" gets a comment, then `adapt_shot`;
  - quiet nudges 1 and 2 and a called-off countdown get answers;
  - noise and other notes get none.

## Acceptance

| Check | Proof |
|---|---|
| "ok I'm going" gets an answer within about 1.5 s | **Measured against the mock:** typed line, through the real relay, to the stand-in and back as a caption: **61 to 77 ms** (samples [73, 60, 61] and [69, 76, 77, 61, 61]). `shoot.test.tsx` "answers a typed line at once…" fails if this goes over 1500 ms. **In production** the remaining time is Gemini's, and is kept short by: 700 ms end-of-turn silence (`silenceDurationMs`); the native-audio model streaming speech as it generates (no separate speech synthesis); every turn answered (the persona's first rule, and notes that need a reply are complete turns); low start sensitivity, so a cough doesn't restart the turn. Written up in `docs/how-it-works.md` "How fast Director answers". Evidence `2-01`. |
| "say my line again" (typed) works | `shoot.test.tsx`: typed "can you say my line again?" gets `It's: "Morning. Coffee first."` through the real relay and the mock. The persona rule "If they ask for their line, say it, just as it is on the card" is checked. Evidence `2-02`. |
| A same-meaning rewording gets no correction | **Persona rules, checked in `live.test.ts`:** "never correct a line said differently", "go with theirs unless they ask for the original", plus the "Rewording a line" example. The mock can't judge meaning, so with real Gemini this rests on the persona; see "Not proven here". |
| "what if I do it with my grandma" gets a comment and a changed card | `shoot.test.tsx` "puts the member's twist on the card…": Director's comment, then the card's Do row reads "You and your grandma do it together" with "changed for you" (only that row); Director hears `done`; after moving to shot 2 and back the card still shows it, and the brief Gemini gets includes `- What they do: "…"`. `director-live.test.tsx`: refused mid-take, and handed to a fresh connection. Evidence `2-03` (glow), `2-04` (settled). |
| 15 silent seconds bring one nudge, never more than two a shot | `live.test.ts` "quiet stretches and a noisy room" (fake timers): no nudge at 14.999 s, one at 15 s, a second 15 s later, never a third on the shot; a new shot gets its own two; none from countdown to recording; dropped when no connection is ready; stopped when the shoot ends. Noise is told once, only for interruptions inside 30 s. Evidence (real timers, real relay, mock): `2-05` first nudge at about 15 s, `2-06` second, `2-07` 20 s later with exactly 2 quiet notes sent. |

Evidence (390×844, headless Chromium, canvas camera, real API and relay, mock Live API; the captions are the mock's scripted lines) is in `v2-evidence/`:

- `2-01-ok-im-going-answered.png`
- `2-02-line-read-back.png`
- `2-03-grandma-card-changed-glow.png`
- `2-04-grandma-card-settled.png`
- `2-05-first-quiet-nudge.png`
- `2-06-second-quiet-nudge.png`
- `2-07-no-third-nudge.png`

They were captured with a throwaway test file that isn't committed.

## Calls I made

1. **`adapt_shot` now, minimally, rather than only a seam.** The acceptance asks for "a changed card", and the spec's 6.6 row is "updates the card, marks changed rows".
   - I added `adapt_shot` with `shot` (a number), `where`, `action`, `line`.
   - Left for slice 4: the spec's `this`/`rest` shot targets, `framing`, `camera`, `why`, `restore_shot` and the ↺ restore, and keeping changes past the page (memory).
   - Changes live for the shoot in the screen's state and in the relay.
   - "Only what changed" is merged: a later call that leaves a field out keeps the earlier change.
2. **The changed row's glow replays whenever the card reappears** (after a take, for example), because the card remounts. It is brief and turned off under reduced motion. Showing it only on the change itself would mean tracking when each change happened, and I didn't think that was worth it yet.
3. **A changed line plays across the whole shot in the teleprompter.** The original's timings belonged to the original words.
4. **The countdown-called-off note now asks for an answer.** "Answers every turn" covers the app's events too. The take-ended note already did.
5. **Nudges and the noise note skip the notes budget, and the relay's own timer sends them.** They aren't the browser's to spend. A nudge due while no connection is ready (mid-rotation) is dropped, not queued.
6. **Proactive audio is deferred to slice 16.** The persona and the notes say when to stay quiet instead.

## Fixes along the way

- **PR #15 (slice 1, `feat/mm/one-shoot-screen`):**
  - Type coverage and coverage were fixed in `6f431b9`.
  - Then Integration failed on "Lovely." missing from the captions. The hold on Director's voice was lifted in an effect that ran after the review painted, so words said the moment a take ended could still be dropped. It is now a layout effect. I made the test speak from a MutationObserver as the review appears, and it failed before the fix. That is `368738d` on the PR branch, cherry-picked as `0879acc`.
  - The other Integration failure, the editor's MP4 test (`edit.test.tsx:582`, waiting 40 s for an upload), touches nothing of mine. It passed on the re-run.
- **API test flake:** `vi.waitFor` advances fake timers, so the quiet nudge was already in flight. The tests now wait with a `settled()` helper that doesn't move the clock, and use a camera frame as a "caught up" signal.

## Not proven here

- **Rewording with no correction, and the friend's tone, with real Gemini.** These rest on the persona and its examples, and need the UAT run with the real model and a voice. No live eval was run in this slice.
- **The 1.5 s budget end to end on real Gemini.** I measured only the app's share (about 70 ms).

## Commits (feat/mm/director-v2, rebased onto origin/master e8526d9)

Slice 1 is in master as the squashed e8526d9, so the rebase dropped slice 1's commits. The two fixes already in it ("type the leave guard…" and "let Director's voice back in…") were dropped as already upstream. The branch's tree is identical to before the rebase, apart from master's own `release.yaml` change. On top of master:

```
1877197 fix(web): dim only the older caption's words, so its glass keeps the contrast
ff4901f fix(web): put a new take's history entry on only after the last one's pop has landed
1cc155c fix(web): open the Leave dialog with focus on Stay, so Enter never leaves by accident
b2ef9b4 docs(docs): update the redesign spec with slice 1's re-review
4ac5a2b feat(api): give Director a friend's persona, quiet nudges and the member's version of a shot
ab45f36 feat(web): show Director's changes to a shot on the card
c981313 feat(fake-google): read the line, nudge on quiet and adapt a shot in the mock Live API
dc1e354 test(web): pin talking with Director: a quick answer, the line read back and a twist on the card
0b8a23d refactor(api): name the contract's bound in the relay's refusal of a long change
eda80b1 docs(docs): describe Director's persona, pacing, adapt_shot and how it answers in time
```

The first four are slice 1's re-review fold-ins (A, B, the focus nit, the spec copy), which weren't in PR #15. The PR #15 hold fix went in as `368738d` before the merge.

**Seams for the parallel slices:**
- contract `liveAdaptation` and the `context` message;
- `lib/your-version.ts` (`adapted`, `yourVersion`, `adaptationList`);
- `ShotCard`'s `changed` prop;
- `useDirectorLive({ adaptations })`;
- relay `adaptations` and `Pacer`;
- `PERSONA` / `PERSONA_VERSION`.

## Tests

- **API live** (`apps/api/src/modules/live`): 78 pass. `live.relay.ts`, `live.setup.ts`, `live.pacer.ts`, `live.persona.ts`, `live.messages.ts` and `live.gateway.ts` are at 100%. Repeated runs are stable.
- **Mock Google live:** 9 pass, and `live.ts` is at 100%.
- **Contracts:** 58 pass.
- **Web unit:** `your-version.test.ts` 5 pass.
- **Web browser (stack 5, single files):**
  - `shoot.test.tsx` 22 pass, 4 skipped (`files` tag, left to CI);
  - `director-live.test.tsx` 20 pass;
  - `shoot-parts.test.tsx` pass.
  - Across those files, `shoot-parts.tsx`, `use-director-live.ts` and `live-session.ts` are at 100%. `shoot.tsx` misses only `onKept`, which the `files`-tagged tests cover in CI.
- **Repo-wide checks:**
  - `bun run lint` passes, including knip, after exporting the bound for the relay's message;
  - `bun run check-types` passes (24 tasks);
  - `bun run type-coverage` passes everywhere;
  - `bun run test` passes (22 tasks);
  - `bun run gen` shows no drift.
