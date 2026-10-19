# Task 2.6.1 report: Gemini TTS for guides

Status: DONE_WITH_CONCERNS (the concerns are about the environment only; see the end)
Branch: worktree-agent-ab53f87070a9cda64 (from origin/feat/mm/director-hackathon at 2afae69)
Commits: 2afae69..52e7eb8

- 5f5ab68 feat(ai): speak Director's guide lines with Gemini's text-to-speech
- 4e54a2d feat(contracts,api): add director.speak, keeping each spoken line in storage
- 52e7eb8 feat(client,web): say shoot-screen guides in Director's own voice

(The guard refused writing to the shared checkout's .superpowers path, so this report is
at the same relative path inside the worktree, uncommitted.)

## What changed and why

### Model check (live, Vertex, through the app's own settings)

`gemini-3.8-flash-tts` answers on Vertex (global, full resource name via
`create_google_model`). I checked it with one-off scripts run as
`PYTHONPATH=apps/ai bun --env-file=.env run uv run --project apps/ai python <scratch>`.
The .env file was never read or printed. These findings shaped the code:

- 3.8-flash-tts answers with `audio/wav` (a whole WAV file). The 2.5 TTS models
  (`gemini-2.5-flash-tts`, `gemini-2.5-flash-preview-tts`) answer with
  `audio/L16;codec=pcm;rate=24000` (bare PCM). The service handles both.
- 3.8-flash-tts refuses `max_output_tokens` with 400 INVALID_ARGUMENT, at every
  value tried (2000, 4000, 8192, 16384). The 2.5 models accept it.
- 3.8-flash-tts refuses `system_instruction` (400). It also reads a delivery note in
  the prompt out loud: "Say warmly ...: <line>" ran 7.2 s, against 3.1-3.6 s for the
  line alone, and the note alone ran 5.3 s. So the line is sent alone, and the choice
  of voice sets the tone.
- Final live check of the app's `Speaker` against Vertex: 3.56 s of 24 kHz mono WAV
  for "Take a small step to your left. Perfect!". It used 10 prompt tokens and 89
  audio tokens, about 25 audio tokens a second.

### apps/ai

- `app/speech.py` (new): `Speaker.speak(org, user, text, voice) -> bytes` (WAV).
  Pydantic AI has no audio output, so this calls the google-genai client underneath
  the model that `create_google_model(settings, TTS_MODEL)` builds. That keeps Vertex
  addressing in one place. The request sets `responseModalities: ["AUDIO"]`, a
  prebuilt voice and a 20 s timeout. `wav_of` passes a WAV file through after checking
  its RIFF/WAVE header, or wraps L16/PCM in a WAV header at the answer's rate (24 kHz
  when the answer doesn't give one). Anything else becomes
  `UPSTREAM_UNAVAILABLE {service: gemini}`: no audio part, text instead of speech,
  mp3, a broken WAV, a refusal or an outage.
- The token budget goes through `app/usage.py`. It reserves
  `DIRECTOR_TOKENS_PER_SPEECH` under the feature `director-speech` with the TTS
  model's short name, and settles in `finally` with the answer's usage. The output
  can't be capped (see above). So when the reservation is smaller than a whole line's
  budget, the request is refused with `AI_BUDGET_EXCEEDED` and the reservation is
  given back in full. The 500-character text limit is what bounds the output.
- `POST /v1/director/speak` (`speakDirectorLine`) takes a strict `SpeechRequest`:
  `text` of 1..500 characters and `voice` from Literal[Puck, Kore, Aoede, Charon,
  Sulafat]. It answers with `audio/wav`, declared in OpenAPI as binary. It is on and
  off with Director: without DIRECTOR_MODEL it answers
  `FEATURE_DISABLED {feature: director}`.
- New settings `TTS_MODEL` (default `gemini-3.8-flash-tts`) and
  `DIRECTOR_TOKENS_PER_SPEECH` (default 3000, at least 1000). Both are in
  `settings.py`, `.env.example` and `docs/environment.md`.
- `tests/fakes.py` gets `gemini_speech(audio, mime_type=...)`, which is the Gemini
  API's generateContent answering with inline audio (PCM by default), and
  `gemini_text_instead_of_speech`.
- There is one `# pyright: ignore[reportUnknownMemberType]`, on `generate_content`.
  Its `contents` type names Pillow's Image, and Pillow isn't installed. It is listed
  in docs/testing.md.

### packages/ai-client

`director.speak(caller, body) -> Uint8Array` reads the answer as a blob (the client's
default is JSON). Anything that isn't `audio/wav` is refused as `UPSTREAM_UNAVAILABLE`.

### packages/contracts + apps/api

- `director.speak` is `POST /director/speech`. Its input is `text` (trimmed, 1..500)
  and `voice` (enum), and its output is `{url, expiresAt}`. It uses `inOrg` and the
  rate limit `director-speech`, 60 a minute per user.
- `DirectorService.speak` uses a new
  `FilesService.keptObjectUrl(key, contentType, expiresIn, make)`. It heads the key.
  Only when the key isn't there does it call the AI service and write the WAV. Then
  it presigns a read that lives 1 hour. The key is
  `director/speech/v1/<sha256(voice + "\n" + text)>.wav`. Without storage it answers
  `FEATURE_DISABLED {feature: files}` before the model is asked.

**Cache choice: object storage through the storage seam, not Valkey.**

- Valkey runs `noeviction` with a 150-300 MB ceiling that it shares with BullMQ's
  queues (set in compose and in the data chart). A spoken line is 100-400 kB of WAV,
  so caching lines there could fill it and make queue writes fail.
- Storage keeps the lines for good and shares them across every workspace. All
  workspaces start with the same 6 seeded templates and the cues are the same
  sentences, so most lines are spoken only once.
- A cache hit costs no tokens.
- The web app already plays media from storage. CSP `media-src` already allows
  STORAGE_ORIGIN, and the plan audio links work the same way.

### packages/client + apps/web

- `@repo/client/api/director/speak`: `useSpeakMutation`.
- `hooks/use-director-voice.ts` (new) gives a `Voice` function, `text -> link`, in
  the voice `Puck`. It keeps each line's link while the link has more than a minute
  left. After a failure it rests for a minute. After `FEATURE_DISABLED` it stops for
  the rest of the session.
- `lib/speech.ts` (the existing voice seam) now takes `say(text, locale, voice?)`.
  - With a voice, the line plays from its link through an `<audio>` element.
    `saying()` still reports the line, so the echo filter and the glow keep working.
  - The browser's speech synthesis says the line instead when the link fails, can't
    be played (autoplay refusals included) or takes more than 2 s.
  - A newer line or `hush()` drops a line that is still on its way and pauses one
    that is playing.
- `useLiveDirector` passes the voice through a small `useSayAloud`. It only speaks
  when `speak && !calling`, so the live call is untouched and Gemini Live still talks
  there. The review page's `say` stays on the browser voice (out of scope).
- docs/director.md ("One voice") and apps/ai/CLAUDE.md now mention it.

## Decisions the brief didn't make

- The voice list is Puck, Kore, Aoede, Charon and Sulafat. The shoot screen uses Puck.
- After a failure the hook rests for 1 minute. Without that rest, every cue waited on
  a failing request first, and cues 0.4 s apart were dropped. The shoot page test
  caught this, because the web suite's AI stand-in has no speak route.
- The fallback waits 2 s. The first time a line is spoken takes Gemini 1-3 s, and a
  cue that arrives late is worse than one in a plainer voice. The request still
  completes and fills the cache for next time.
- The storage key doesn't include the TTS model, because the API doesn't know it.
  Bump the `v1` prefix to have every line spoken again after a model change.
- There is no bucket lifecycle rule for `director/speech/`. The set of lines is small
  and bounded by the plans. Add a rule if it grows.

## TDD evidence (failing first)

- ai: `bun run --cwd apps/ai test:integration tests/test_speech.py`, run before the
  route existed, gave `17 failed` (every call got a 404).
- ai-client: `Tests 3 failed | 10 passed`, with
  `TypeError: client(...).director.speak is not a function`.
- api: `bun run --cwd apps/api test:integration:files test/director.integration.test.ts`,
  run before the service existed, gave `Tests 3 failed | 22 skipped`
  (INTERNAL_SERVER_ERROR, because there was no handler).
- client: `Error: Cannot find module './speak'`.
- web: the first run of the speech, use-director-voice and live-hooks tests gave
  `Tests 6 failed | 24 passed`. The hook module didn't exist, and the Gemini-voice
  tests failed because the voice was ignored.
- The change to send the line without a delivery note: the test now asserts that
  the request's parts are exactly the line, which the old prompt didn't satisfy.

## Commands and output tails

Stack: `bun run setup --stack 4`, plus `bun scripts/services.ts up --files` for
RustFS. The stack was stopped with `bun run db:down` at the end.

- `bun run lint`: exit 0.
- `bun run check-types`: `Tasks: 24 successful, 24 total`, exit 0.
- `bun run type-coverage`: exit 0.
- `bun run test`: `Tasks: 22 successful, 22 total`, exit 0.
- `bun run --cwd apps/ai coverage` (unit + integration): `175 passed`,
  `TOTAL 1465 0 198 0 100%`. `app/speech.py` is at `82 0 18 0 100%`, and main,
  schemas, settings and usage are all at 100%.
- `bun run --cwd apps/ai lint`: `All checks passed!`, and deptry reports
  `No dependency issues`. `bun run --filter @repo/ai check-types`: `0 errors`.
- `bun run --filter @repo/api coverage` (every api project, files-tagged included,
  with RustFS up): `Test Files 34 passed (34)`, `Tests 311 passed (311)`.
- `bun run --filter @repo/ai-client coverage` and
  `bun run --filter @repo/client coverage`: exit 0 (`Tests 13 passed` and
  `Tests 84 passed`).
- `bun run --filter @repo/web coverage` (all 534 web tests): `Tests 1 failed | 533
  passed`. The one failure is
  `test/settings/avatar.test.tsx > says so when storage refuses the upload`. That test
  hard-codes RustFS's default port `:59000`, but stack 4 moves RustFS to 59400. It
  fails the same way when run alone, and it is unrelated to this change.
- `bun scripts/coverage.ts` after the runs: no touched file is below 100%. The 179
  files it lists belong to packages whose suites weren't part of these runs (ui
  stories, nest-common, testing).
- `bun test ./scripts/ ./.claude/hooks/`: `970 pass, 3 fail`.
  - The dockerfiles test failed only because the new files were still untracked. It
    passes after the commits (`8 pass 0 fail`).
  - The two "database steps" tests expect port 55432 and get stack 4's 55832, so
    that failure comes from the environment.
- `bun run gen`: no drift after the commits.

## Concerns

- Under load, full web runs showed a few unrelated 30 s timeouts: the live-call
  remount, the camera refusal and the director page. They pass when rerun alone. The
  load from other agents on this machine looks like the cause.
- Stack 4's Postgres crashed into recovery twice during web runs ("untracked child
  process exited with exit code 2", then a restart). The reruns passed.
- Chromium refuses to play audio until the page has been touched, so the web tests
  click the page first. On a phone the member has tapped their way to the shoot
  screen, and if playback is refused the browser voice says the line anyway.
