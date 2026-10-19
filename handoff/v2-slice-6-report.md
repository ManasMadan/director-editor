# Director v2, slice 6: the slower line (report)

Branch `feat/mm/v2-slower-line`, rebased onto `origin/master` (slices 1 and 2 squashed in), pushed. Stack 3 (torn down).

## What I built

**API**

- **`director.chat`.** The contract is in `packages/contracts/src/api/director-chat.ts`, mounted under `director`. It is rate-limited at 30 a minute per user.
  - Input: the turn (`said` text, `start`, `camera`, or `take` state), an optional JPEG frame, the adaptations, the last 8 lines, and what came of the last reply's tool calls.
  - Output: `{ reply, calls: LiveToolCall[] }`.
- **`apps/api/src/modules/live/live.chat.ts` (`DirectorChat`).** It calls Vertex AI `generateContent` directly, with the API's existing `GoogleAuth`, at the global endpoint. The model is `CHAT_MODEL` (default `gemini-3.8-flash`).
  - Same persona and shot brief as Live: `systemInstruction` from `live.setup.ts`, which carries slice 2's `PERSONA`, plus a short "slower line" paragraph.
  - Same tool declarations as Live, and the same app notes for a camera flip or a take.
  - If Gemini returns only tool calls, a second request gets the words, with each call's outcome. Gemini 3's thought signatures are passed back.
  - Stateless between turns.
- **One tool implementation.** The relay's argument checks moved to `live.tools.ts` (`checkTool`, `TOOL_RESPONSES`, `toolNamed`), which both Live and the slower line use. In the browser, slower-line calls run through the shoot screen's existing `useTools` handler via the same `onTool` path as Live.
- **Text-to-speech.** It reuses `director.speak` (Gemini TTS, cached in storage) in Live's voice, which is now `LIVE_VOICE` in `contracts/live.ts`.
- **New env vars**, each in env.ts, `.env.example` and `docs/environment.md`:
  - `CHAT_MODEL`
  - `CHAT_API_URL`: a test hook; anything but https is refused in production.
  - `LIVE_OFF_USERS`: user ids. The Live gateway refuses them with `FEATURE_DISABLED`, which sends them to the slower line. This is the UAT switch "Live off for your account".
- **Mock Google** (`packages/fake-google/src/chat.ts`) now serves Vertex `generateContent`:
  - a hello;
  - `adapt_shot` for "inside";
  - a `go_to_shot` that comes back with only the call, to exercise the second round;
  - a 503 outage switch.

**Web**

- **`lib/slow-session.ts`** has the same controls as a Live session, so the hook and screen don't care which line is running.
  - Turns are queued in order, each with a frame.
  - The reply is captioned at once, its calls are handed to the screen, then it is spoken via `director.speak`. That uses a new `wavSamples` reader and a sample-rate argument on the existing player.
- **`lib/dictation.ts`** uses the browser's SpeechRecognition as dictation only.
  - It pauses while Director speaks and during takes.
  - It retries after passing errors.
  - If it is refused or missing, the screen shows "deaf" and the member types.
- **`use-director-live.ts`** moves Director to the slower line after Live's silent retry fails, or when Live is refused (off for the member, rate-limited, out of time).
  - Only what neither line can fix leaves Director "unavailable": signed out, no workspace, plan or shot gone, another tab, a validation failure.
  - The hook has new `line`, `away` and `reconnect()` fields. `reconnect()` reopens Live with `resume=1` and the shoot's adaptations as `context`, and falls back to the slower line if Live still fails.
- **`components/slower-line.tsx`:**
  - `SlowerLinePill`: "Slower line · Reconnect", under the indicator.
  - `AwayBanner`: the spec's banner, with Try again.
  - Both sit behind one small `SlowerLine` seam in the shoot screen's top band.
  - New i18n keys: `director.live.slower`, `reconnect`, `away`.
- **Docs:** a new "The slower line" section in `docs/how-it-works.md`.

## Acceptance

| Check | Proof |
|---|---|
| With Live off, the pill shows | Browser test (`director-live.test.tsx`, "Director's slower line"): when Live is refused with `FEATURE_DISABLED`, "Slower line" and Director's opening line show and the text box is enabled. Live dropping twice does the same. |
| Spoken and typed turns answered within about 4 s | Browser tests: a typed turn comes back through the real API and the mock in under 4 s (asserted); a dictated phrase from a stubbed recogniser is answered. **Live on Vertex:** warm turns took 3.6 s and 4.3 s for the text. Then comes a `director.speak` round trip (about 1–2 s when the line isn't cached), so the caption lands at about 4 s and the voice after it. A cold first turn took 9.4 s. |
| "I'm fine inside" still adapts the card | Browser test: a dictated "nah I'm fine inside" brings the reply, the Where row "Inside, by a window" and "changed for you". **Live on Vertex:** the reply and `adapt_shot {shot 0, where "Inside"}` came back in one answer. |
| Recording continues | In every slower-line and banner test, "Record a take" stays enabled. |
| Reconnect brings Live back with chips intact | Browser test: Reconnect opens Live with `resume=1` and sends `context` with the adaptation; the pill disappears and the card keeps the change. If Live fails again, Director falls back to the slower line. Chips are slice 4's; they live in screen or memory state, which the slower line doesn't touch. Re-check after slice 4 merges. |
| With Gemini blocked, the banner shows and recording continues | Browser test: with `/rpc/director/chat` returning 502, the banner shows the spec's text, the shutter stays enabled, and Try again retries. API unit test: a Vertex 503, or Vertex out of reach, gives `UPSTREAM_UNAVAILABLE` and is logged. |
| The footage is sorted once Gemini is back | Not built here. It depends on slices 3 and 5 (continuous recording and the post-session pass). In today's per-take mode, takes are reviewed by the existing job retries. |

## Decisions

- **Vertex is called from the API, not apps/ai.** That keeps one persona, one set of declarations and one set of tool checks, shared with Live. The cost: the slower line isn't on the AI token ledger (Live isn't either); the procedure's rate limit bounds it.
- **What falls back to the slower line:** dropped, UPSTREAM_UNAVAILABLE, INTERNAL, FEATURE_DISABLED, RATE_LIMITED and TIMEOUT.
- **What the slower line answers:** a called-off countdown, a recorded take and a camera flip. It sends no quiet nudges and says nothing when the member moves to another shot, to keep cost and latency down.
- **Try again and Reconnect do the same thing:** try Live, then fall back.
- **Banner wording:** the spec's text, "You're still recording". In per-take mode that's only loosely true until slice 3 lands.
- **Thinking and timeout:** thinking is LOW, the least Gemini 3 Flash allows (`MINIMAL` returns a 400, checked live). The timeout is 20 s, because a cold first turn took 9.4 s.

## Commits

- `b08aec2` fix(api): wait up to 20 seconds for a slower-line answer
- `58c7082` test(web): pin the slower line: answers, the card adapting, Reconnect and Gemini out of reach
- `2677f99` docs(docs): describe Director's slower line, and pin the mock's answers to it
- `b5a886a` feat(web): carry on with Director on the slower line when Live can't run
- `c96455e` feat(api): give Director a slower line, turn by turn on Gemini Flash with Live's persona and tools

## Tests

- **API unit:** 295 pass, including `live.chat.test.ts` (10 tests, against the mock Google) and a new refusal case.
- **Contracts:** 59 pass.
- **Client:** 88 pass, including a test for the chat hook.
- **Mock Google:** `chat.test.ts`, 3 pass.
- **Web unit:** the WAV reader tests pass.
- **Browser:** `director-live.test.tsx`, 25 tests. Every changed and new test passes. Two older tests failed once under machine load (a sign-up 500, and the database not accepting connections) and passed on rerun.
- **Not run:** shoot.test.tsx and e2e, per the time box.
- **Lint, check-types and type-coverage** are clean for api, web, client, contracts and fake-google. `@repo/ai` check-types failed with "Failed to get PID", an environment error.

## For the controller

- **Merging:**
  - `shoot.tsx` gets one line in Overlay's top band (`<SlowerLine live={live} />`) and the `SlowerLine` function.
  - `use-director-live.ts` gets the hook changes. Slices 2 and 4 touch the same area.
- **Deploying:**
  - Nothing is required: `CHAT_MODEL` defaults to `gemini-3.8-flash` and uses the existing project and service account.
  - For the UAT, set `LIVE_OFF_USERS=<owner's user id>` on the api, then clear it before the "Reconnect" step.
  - The service account needs Vertex `generateContent` on the global endpoint. It should already have it, since Live uses aiplatform.
- **Watch:**
  - Latency is tight. A lighter `CHAT_MODEL` would help, if the owner accepts one.
  - `MAX_OUTPUT_TOKENS` is 400 and counts thinking tokens. It was fine in the live check; raise it if replies ever come back cut short.
