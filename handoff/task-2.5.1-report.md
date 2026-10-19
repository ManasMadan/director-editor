# Task 2.5.1 report: the Gemini Live relay in the API

Status: done, uncommitted. Worktree `/Users/manas.madan/Desktop/code/director-editor/.claude/worktrees/agent-a5a33cf0a9b54323b`, branch `worktree-agent-a5a33cf0a9b54323b` (from master 3d5809c).

## What I built

`apps/api/src/modules/live/`:

- `google-auth.ts`: the `GoogleAuth` interface (`accessToken()`). `metadataServerAuth()` asks the GCE metadata server (`Metadata-Flavor: Google`), parses the answer with zod and caches the token until 60 s before `expires_in`. `createGoogleAuth(GOOGLE_ACCESS_TOKEN)` returns the pasted token when it's set (dev only), otherwise the metadata server.
- `live.setup.ts`: the `setup` message. It has `model: projects/{p}/locations/{l}/publishers/google/models/{m}`, `generationConfig.responseModalities: ["AUDIO"]`, the voice `Sulafat`, `systemInstruction` (the director persona plus a `<shot>` block with the scene, framing, phone angle, pose, steps and script, marked as data and not instructions), `tools[0].functionDeclarations` for the five tools (each takes an optional `reason`), and `realtimeInputConfig.automaticActivityDetection` with `activityHandling: START_OF_ACTIVITY_INTERRUPTS` for barge-in. It also turns on `inputAudioTranscription`/`outputAudioTranscription` and sets `contextWindowCompression.slidingWindow`, because without it an audio+video session stops at about 2 minutes. The file also holds the greeting turn (a `clientContent` that gets the director to speak first) and `liveUrl(location)`.
- `live.messages.ts`: zod schemas for client messages (`audio` up to 90k base64 chars, `frame` up to `DIRECTOR_FRAME_MAX_LENGTH`, `text` up to 2000 chars) and for the upstream fields the relay reads. It also sets the payload caps: client 404 KB as ws `maxPayload`, upstream 8 MiB.
- `live.relay.ts`: `LiveRelay` handles one call.
  - Client to upstream: `audio` becomes `realtimeInput.audio` (`audio/pcm;rate=16000`), `frame` becomes `realtimeInput.video` (`image/jpeg`, at most 1 per second, extra frames dropped), and `text` becomes `clientContent`.
  - Upstream to client: `audio/pcm*` parts of `serverContent.modelTurn` go out as `audio`; input and output transcriptions go out as `transcript` (who is `you` or `director`); `interrupted` goes out as `{type:"interrupted"}` (see concerns).
  - Tool calls: each `toolCall.functionCalls[]` entry for a known tool is sent to the client as `tool` with `args: {reason?}`. All calls get one `toolResponse.functionResponses` back, `{result:"done"}` for known tools and `{error:"unknown tool"}` for anything else.
  - Before `setupComplete`, client messages are dropped. A binary, non-JSON or invalid client message ends the call with `VALIDATION_FAILED`.
  - Endings: a token failure, an upstream close or a failed upstream connection sends `{type:"error", code:"UPSTREAM_UNAVAILABLE"}` and closes with 1011. The 10-minute cap sends `TIMEOUT` and closes with 1008. When the client hangs up, the relay closes the upstream. Upstream close codes and reasons go to the log, because that is the only place Vertex reports a refused setup.
- `live.gateway.ts`: `mountLive(fastify, options)` listens for `upgrade` on the API's Node server at `/api/live` (it is under `/api`, so the gateway's existing route reaches it).
  - Before the upgrade: other paths get a 404. An `Origin` header that isn't `WEB_URL` or `APP_ORIGINS` gets a 403, which blocks cross-site WebSocket hijacking. A client with no Origin (not a browser) is allowed.
  - After the upgrade it checks, in order: feature on (`FEATURE_DISABLED`), query valid (`videoId`, `shot` from 0 to 11, else `VALIDATION_FAILED`), caller resolved exactly as `inOrg` does, no other call open for this user (`CONFLICT`), the hourly limit (`RATE_LIMITED`), and a plan that is ready and has the shot (`DIRECTOR_PLAN_NOT_FOUND` when the plan is missing or not ready, `DIRECTOR_SHOT_NOT_FOUND` when the shot is out of range). Then it runs the relay.
  - Any refusal sends an error message and closes the socket. A 5xx or unknown error is logged and goes out as its code or `INTERNAL`.
  - Open calls are terminated in Fastify's `preClose`.
  - `liveUpstream()` returns null when `GOOGLE_CLOUD_PROJECT` is unset, which turns the feature off.
- `index.ts`: the barrel.

Wiring and the other edits:

- `server.ts`: `mountDirectorCall`.
  - The caller is `orgCallerFor(auth, memberships, …)` with no scope, so API keys get `FORBIDDEN` and the session cookie, active org and membership checks are the same code `inOrg` runs.
  - The plan comes from `DirectorService.plan` (the AI service's plan for that org and video).
  - The rate limiter is Redis `director-calls` at 20 calls an hour per user, failing closed.
  - Logs go to pino, and `now` is `Date.now`.
- `rpc/procedures.ts`: I only exported `orgCallerFor`, so the live route doesn't reimplement session and membership checks.
- `http-context.ts`: `toHeaders` now takes any `{ headers: IncomingHttpHeaders }`. An upgrade is a raw Node request; this is a type-only change and existing callers are untouched.
- `env.ts`: added `GOOGLE_CLOUD_PROJECT` (validated as a project id), `LIVE_LOCATION` (default `us-central1`, a region regex so it can't inject a host), `LIVE_MODEL` (default `gemini-live-2.5-flash-native-audio`) and `GOOGLE_ACCESS_TOKEN`. Production refuses to boot with `GOOGLE_ACCESS_TOKEN` set. All four are also in `.env.example` and `docs/environment.md`, and `env.test.ts` has a case for the production guard.
- `apps/api/package.json`: added `ws` ^8.21.3 and `@types/ws` ^8.18.1 (both were already in the lockfile through other packages); `bun.lock` updated by `bun install`. Node 24 has no WebSocket server, and its global client can't send an Authorization header.

## Tests

- `src/modules/live/live.test.ts` (33 tests): a bare Fastify server with `mountLive`, a `FakeLiveApi` (a real `ws` server that answers `setup`, records what arrives and can hold the handshake), a fake GoogleAuth and fake caller/plan/limit. It covers:
  - Setup carries the model path, the shot's script and scene, the five tools, transcription and VAD, plus the Bearer token.
  - Audio, text and frames are forwarded, with the 1 fps drop and the clock advanced.
  - Upstream audio, transcripts and interrupted reach the client.
  - A tool call reaches the client as `tool`, upstream gets a `toolResponse`, and an unknown tool gets an error response.
  - Unreadable upstream messages are skipped.
  - Upstream close sends error then 1011; token failure and an unreachable upstream do the same.
  - Client hangup closes the upstream, including when it happens during the handshake or while the token is being fetched.
  - The 10-minute cap, tested with fake timers.
  - Input before ready is dropped. Invalid, binary and non-JSON input is refused. An oversized payload gets 1009 and a log line.
  - Server close ends open calls.
  - Refused when the feature is off, the caller is unauthenticated, rate limited, the plan is missing or not ready, the shot is out of range, or the query is bad.
  - A second concurrent call gets CONFLICT, and a call works again after the first ends.
  - Plan load failures give INTERNAL or UPSTREAM_UNAVAILABLE, both logged.
  - A browser that left while the plan loaded leaves nothing behind.
  - Origin 403, other path 404, a client with no origin allowed.
  - Config and system-instruction edge cases.
- `src/modules/live/google-auth.test.ts` (3 tests): a stand-in metadata server checks the header, the caching until a minute before expiry, a refusal, and the pasted token.
- `test/director.integration.test.ts` (+3 tests, real server, session cookie, AI stand-in): an unauthenticated browser gets UNAUTHENTICATED; a member's missing plan and pending plan both get DIRECTOR_PLAN_NOT_FOUND, asked of the AI service as that member; an AI failure gets UPSTREAM_UNAVAILABLE and 1011.

Results:

- `bun run --filter @repo/api check-types`: pass.
- `bun run lint`: every step passes.
- `bun run type-coverage apps/api`: pass.
- `bun run --filter @repo/api test`: 32 files, 195 tests passed.
- `bun test` for `scripts/env-docs.test.ts`, `durations.test.ts` and `ports.test.ts`: 13 passed.
- The director and features-off integration files: 22 passed. The full `test:integration` run is in the reply.
- Coverage of the unit tests plus the director, api-keys and mcp integration tests: 100% statements, branches, functions and lines for every file in `src/modules/live/` and for `src/server.ts`. The unit run alone also covers `env.ts` and `http-context.ts` at 100%.

## Live smoke (Vertex, project project-18e15b18-c92e-44bb-9bf, us-central1, gcloud token)

1. A raw script (Node plus `ws`) used `setupMessage()` and `greetingMessage()` from this code, then sent `realtimeInput.audio` (silence) and `realtimeInput.video` (a JPEG), then a text turn asking to record. Results: `setupComplete` arrived, 47 audio chunks came back, the output transcription read "Hello! For this shot, let's get a close-up on the coffee mug, centered in the frame. Great, I see the mug. Remember to say "Good morning!" as you pour. Ready to record!", and `toolCall` was `start_recording({"reason":"Filmer is in place and ready to pour and speak."})` with an id. Our `toolResponse` was accepted and the socket never closed with an error. That confirms every field name, the voice, `activityHandling` and `contextWindowCompression`.
2. A temporary vitest file (deleted afterwards) ran the real `mountLive` and relay against Vertex. The client got 39 `audio` messages and director transcripts, then a `tool` `start_recording {"reason":"Filmer is in place and ready to record the first shot."}`, with no errors and no logs.

Under Bun, the `ws` client never got `setupComplete` from Google (it hung). Under Node, which the API runs on, it works. This only matters for anyone writing Bun scripts against the Live API.

## Concerns and follow-ups

- I added `{type:"interrupted"}` (server to client), which isn't in ws-2.5-interfaces.md. Without it the browser can't throw away queued director audio when the filmer barges in. A client that ignores unknown types is unaffected, but the web hook should handle it.
- Deploy: `GOOGLE_CLOUD_PROJECT` (and `LIVE_*` if not the defaults) still needs adding to the api's env in `deploy/environments/production/stack.yaml` or `values.yaml`. The GCE service account needs `roles/aiplatform.user`, and the VM's access scopes must allow cloud-platform. I left `deploy/` alone to stay in scope.
- Gateway timeout: the `/api` HTTPRoute has no `timeout`, while `/rpc` sets `timeout: 0s` for its streams. If the production gateway applies a default request timeout to upgraded connections, calls will be cut short. A `- path: /api/live` route with `timeout: 0s` would make it explicit.
- Local dev: the browser reaches `/api` through Next's rewrite. Whether Next's dev proxy forwards WebSocket upgrades needs checking in 2.5.2; if not, the web hook can connect to `API_URL` directly in development.
- The feature isn't in `features` / `system.info` (that touches `packages/contracts` and the generated OpenAPI). The route answers `FEATURE_DISABLED` instead, and the web side can rely on that.
- The one-call-per-user limit is per API process (an in-memory set). With several replicas a user could hold one call on each, each still capped at 10 minutes and counted in the shared Redis hourly limit (20 per user).
- No new error codes and no i18n changes. Refusals use existing codes: CONFLICT for a second call, TIMEOUT for the cap.

## Fix round 1 (security review of 88eb60f)

These changes are on top of 88eb60f and are not committed. The files touched are `live.gateway.ts`, `live.relay.ts`, `live.messages.ts` and `live.test.ts`, plus a new `live.budget.ts`.

1. CRITICAL, client reset could crash the process. The first thing the upgrade listener now does is attach `socket.on("error", …)`, which logs a warning ("live upgrade socket failed"). The listener is taken off again once ws has upgraded the socket, because ws adds its own. `refuse()` now writes the status line and then destroys the socket (`socket.end(…, () => socket.destroy())`).
   - New test "keeps serving after a client resets its connection on a refused upgrade". It opens raw TCP connections to `/api/live` with a foreign Origin (403) and to `/plain` with an upgrade (served by Fastify), calls `resetAndDestroy()` on each after the first bytes arrive, and then checks that a normal live call still connects.
   - Against the old code (listener removed, no destroy), the same test reports `Unhandled Errors: read ECONNRESET` and the run fails. That is the reviewer's crash, so the test guards it.
   - A second test emits `upgrade` directly with a non-live path and a stand-in socket, and makes that socket fail. It covers the 404 fallback and the error listener's log line.
2. IMPORTANT, budgets and backpressure. New `SlidingBudget` in `live.budget.ts`. Each call gets two budgets, and any refusal ends the call with `RATE_LIMITED` (close code 1008):
   - Microphone audio: up to twice real time, 64 KB/s of decoded PCM16 measured over a sliding 5-second window (320,000 bytes).
   - Typed turns: 3 per 10 seconds.
   - Backpressure: before forwarding anything, the relay checks `upstream.bufferedAmount`. Above 1 MiB (about half a minute of audio) it logs "live upstream fell behind" and ends the call with `UPSTREAM_UNAVAILABLE`.
   - New tests. Audio: four chunks of 66,000 bytes go through, the window slides after 5 s and four more go through, and the fifth is `RATE_LIMITED`. Text: three turns go through and the fourth is `RATE_LIMITED`. Backpressure: the stand-in stops reading and 300 KB frames are pushed until the call ends with `UPSTREAM_UNAVAILABLE`, close code 1011.
3. Other paths' upgrades. The gateway sets `fastify.server.shouldUpgradeCallback` to `/api/live` only (Node 24.9+ reads it per request, through `Object.assign` because `@types/node` has it only as a constructor option). Every other upgrade, such as h2c to `/rpc`, goes through Fastify's routing as an ordinary request. The listener still refuses non-live paths with 404, for a Node that lacks the callback.
   - New test "leaves other paths' upgrade requests to the server's own routes": `Upgrade: h2c` to `/plain` gets `200 OK` and the route's body.
4. The hourly limit is charged only after the plan is loaded and the ready and shot checks pass.
   - New test "charges the hourly limit only for a call that can start": with a plan that isn't ready, `spendCallLimit` is never called.
5. Setup timeout. When the upstream opens, the relay starts a timer of `PROVIDER_TIMEOUT_MS` (10 s). If `setupComplete` hasn't arrived by then, it logs "live setup never completed" and ends with `UPSTREAM_UNAVAILABLE`. The timer is cleared on `setupComplete` and in `end()`.
   - New test with fake timers.
6. A long tool `reason` is now cut to 500 characters. Before, it counted as an unknown tool. The call still reaches the browser and Gemini gets `{result:"done"}`.
   - New test with a 600-character reason.

I also fixed a Biome `noConfusingVoidType` warning in a test from round 0, using `Promise.withResolvers`.

Commands and output:

- `bun run --filter @repo/api coverage -- --project unit --coverage.include='src/modules/live/**' src/modules/live`: 45 passed (45). "No files with missing coverage. 6 files fully covered." I ran it three times and got the same result each time.
- `bun run --filter @repo/api check-types`: exited with code 0.
- `bun run lint`: every step passes (biome, boundaries, unused, markers, patterns, suppressions, prisma, actionlint, zizmor, shellcheck, hadolint, tflint, renovate, turbo lint).
- `bun run type-coverage apps/api`: pass.
- `bun run --filter @repo/api test`: 32 files, 204 tests passed.
- `bun run --filter @repo/api test:integration`: 13 files, 266 passed, 14 skipped.
