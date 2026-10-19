I reviewed origin/master at `b9988e3d`. It moved from #36 to #37 during the review; #37 adds the BigQuery turn events and proactive audio and removes the scene check, so I reviewed it too. Line numbers are for that commit.

I did not write `review-api.md`: my instructions don't allow writing report files, so the full findings are below for you to save.

## Findings

**[blocker] `apps/api/src/modules/live/live.gateway.ts:289-323` and `live.relay.ts:258` — Everything the browser sends right after its socket opens is lost.**
- **Cause:** the relay starts listening for messages only after the gateway has awaited sign-in, the plan and the call limit. The `ws` library throws away messages that arrive before anyone is listening.
- **Scenario:** at socket open the browser sends the member's version (`context`), the current shot, the roll's state and microphone audio (`live-session.ts:223`, `use-roll-shoot.ts:81-85`). The version is only sent again when it changes, so Director is set up and greets the member with the original plan and an empty memory. It never hears that the roll is recording (the persona marks only "when the app says the roll is on"), so it never marks attempts and no takes are cut during the shoot.
- **Tests:** the test at `live.test.ts:1187` waits until the upstream is open before sending, so it misses this.
- **Fix:** in `call()`, attach a message listener straight after the upgrade that queues messages, then replay the queue into the relay (or pause the socket and resume it once the relay exists).

**[major] `live.relay.ts:412-417` (`note`), `:361-369`, `:533-545` — The roll and take state is dropped until Gemini's setup completes, and is never restated.**
- **Scenario:** `roll.start()` resolves and sends `roll: "recording"` within the second or two before `setupComplete`, so the relay drops it. The same gap exists when the old connection closes before a rotation finishes. A rotation without a resumption handle only catches Gemini up with the last few lines, not the roll state. Either way Director stops marking attempts.
- **Fix:** keep the latest roll and take state in the relay, as it already keeps `version`. Send it in `lineReady` and in the catch-up message.

**[major] `live.gateway.ts:310-311` — A reconnect after a network drop is refused with CONFLICT, and Director is gone for the rest of the shoot.**
- **Cause:** there is no ping/pong. When a phone switches network, the server never sees the old socket close, so the user stays in `calling`.
- **Scenario:** the web retries once with `resume=1` after 2 s and gets CONFLICT, which `use-director-live.ts:61` treats as final (no slower line either). Meanwhile the orphaned relay keeps Gemini open, and billed, for up to 30 minutes.
- **Fix:** let the newest connection win (end the user's existing relay), and add a ws heartbeat that ends sockets that stop answering pings.

**[major] `live.relay.ts:658` — A second `adapt_shot` on the same shot erases the earlier changes from the relay's copy of the version.**
- **Cause:** zod 4 keeps keys that are present but `undefined`. I checked this with bun: `{...{where:"kitchen"}, ...parsed}` gives `where: undefined`.
- **Scenario:** the browser sends `context` first (`use-your-version.ts:13`, "briefed before a tool call is answered"), then `tool_result`. The relay merges the parsed adaptation on top and wipes the `where`/`line` changes the member made earlier. Later shot moves, rotations and replan answers then describe the original place and line.
- **Fix:** drop undefined keys before merging (filter the entries, or build the adaptation only from fields Gemini sent). Add a test that adapts the same shot twice.

**[major] `live.relay.ts:384-401`; `live.setup.ts:162-172`, `:179-182`, `:201-203` — Shot changes Director makes itself cut off its own sentence.**
- **Cause:** a `clientContent` message from the client interrupts whatever the model is generating, whether or not `turnComplete` is set.
- **Scenario:** after `go_to_shot`, or `skip_shot` on the current shot, the relay sends the tool response, Director starts confirming, and the browser's navigation then sends `{type:"shot"}`. `moveTo` sends a second turn that asks for an answer, which interrupts the confirmation and makes Director introduce the shot again. Notes that ask for no answer (`restored`, `versionMessage`) still stop Director mid-sentence.
- **Fix:** when a move matches a Director call that is pending or was just answered, put the shot's brief in the tool response (or send it with `turnComplete:false` after `turnComplete`). Hold notes that ask for no answer until the model's turn ends.

**[major] `live.relay.ts:315-321`, `:526`, `:533-545` — Session rotation cuts Director off mid-sentence and loses recent speech.**
- **Scenario:** the 9-minute timer, or `goAway`, swaps connections as soon as the new one is ready. The old connection is closed while Director is still sending audio or a tool call is pending (`live.test.ts:1680` confirms that answer is dropped). Because the new connection counts as resumed, nothing said after the last resumable handle is caught up, so a question the member asked during the swap never gets an answer.
- **Fix:** before taking over, wait for `turnComplete`, no pending tools and a fresh handle, with a hard deadline from `goAway.timeLeft`.
- **Related, minor (`lineClosed`):** if the new connection fails during a rotation, the whole call ends even though the current connection is healthy. Retry or keep the current one.

**[major] `live.relay.ts:425-433` — A short network stall ends the call.**
- **Scenario:** after a stall of about 5 s or more, the browser flushes its buffered audio in one burst. That plus the next few seconds of live audio exceeds the 2x-real-time/5 s allowance, and the call ends with `DIRECTOR_CALL_TOO_FAST`, moving the member to the slower line. Until then the stale audio still goes to Gemini, so Director answers late.
- **Related:** when Gemini's socket backs up past 1 MiB (about 3 frames), the relay ends the call instead of dropping frames.
- **Fix:** drop audio over the allowance instead of hanging up, skip frames once `bufferedAmount` passes roughly 128 KB, and end only when audio itself can't get through.

**[major] `apps/worker/src/recording/clip.processor.ts:190`, `apps/api/src/modules/director/director.service.ts:262` — Takes are reviewed against the original shot, not the member's version.**
- **Cause:** `createTake` never carries `director_version`, and the AI review compares the take with "the shot: its scene, framing, steps and script".
- **Scenario:** a member who moved the shot to the kitchen or changed the line is scored down, and the best segment is picked by the original script's timing.
- **Fix:** have the API (or the clipper) read the version and pass the shot as the member has it (`applyShotVersion`) into `createTake`, and on to the review.

**[major] `apps/api/src/server.ts:141-142`; `live.relay.ts:626` — "Use the second one" can silently pick the wrong take.**
- **Cause:** takes are numbered by the take's `createdAt`. Takes from the roll are created by the clipper, two at a time and out of order (`RECORDING_CONCURRENCY` 2), and a failed clip or a take found by the session pass shifts the numbering. Separately, `tally.onTake("recorded")` counts when Director calls `mark end`, even if the browser then refuses it (`not_recording`, `paused`).
- **Fix:** number by recording attempt (this session's attempts for the shot, ordered by `attempt.number`, mapped to their `takeId`), and count an attempt only when the browser answers `done`.

**[major] `apps/api/src/modules/recording/recording.service.ts:357-369` — The post-session pass can be lost for good.**
- **Scenario:** `director.add("session-pass")` runs after the commit, and only when this call flipped the status. If Redis fails there, a retried `finish` gets `finished=false` and never queues it. Sessions closed by the idle sweeper (`maintenance.processor.ts`, `recordingRetention`) never queue a pass either.
- **Fix:** queue it whenever the session's status is `done` (the session id as `jobId` already makes it run once), or emit it through the outbox in the same transaction.

**[major] `packages/contracts/src/api/director.ts` (#37) — `director.checkScene` (POST `/director/{videoId}/scene-checks`) was removed without `!` in the commit title.**
- **Why it matters:** `api-compat` treats a removed procedure as breaking, and any client still calling it gets a 404.
- **Fix:** declare it as breaking with `feat(api)!`, or deprecate the procedure before removing it.

**[minor] `live.relay.ts:597-631` — The quiet nudge can fire while a tool call is still pending.** A replan can take up to 30 s with nothing heard, so the 15 s nudge sends a turn that asks for an answer while Gemini is waiting for the tool's response. Pause the pacer while anything is pending.

**[minor] `live.relay.ts:133`; `live.marks.ts:21` — Tool answer deadlines are shorter than the work they wait for.** The 30 s replan deadline leaves almost no slack over the AI's 25 s model timeout plus the network hops. The 12 s `point_at` deadline is under locate's 20 s timeout, so Gemini can hear "the app didn't answer" and then a box appears anyway. Add margin to both.

**[minor] `live.relay.ts:440` — About half the camera frames are dropped.** The browser sends exactly every 1000 ms (`live-session.ts:137`) and the relay drops anything closer than 1000 ms, so network jitter discards roughly half the frames after they've already used the phone's upload. The web also sends frames without checking `bufferedAmount` (outside the paths you asked about), which can delay audio on a weak connection. Allow about 0.8x the interval in the relay, and skip a frame in the browser when its socket is backed up.

**[minor] `apps/api/src/modules/your-version/your-version.service.ts:54` — `revise` overwrites changes saved while it runs.** A chip removed or a row restored during a replan is lost. Save only if the version hasn't changed since the replan started (a revision number or `updatedAt` check).

**[minor] `apps/api/src/modules/assets/stock/stock.ts:94`, `:148`; `assets.service.ts:198` — Stock provider failures return the wrong error, and failed adds leave files behind.** A failed provider lookup, a parse error or a download timeout becomes INTERNAL instead of UPSTREAM_UNAVAILABLE. The copy is written to storage before the AI service accepts the slot, so a refusal leaves the object behind.

**[minor] `apps/api/src/modules/assets/assets.service.ts:225-233` — The synthetic-media flag doesn't reflect the uploaded cut.** It is computed from the current slot choices, not from what the saved cut actually used, and AI-made realistic images are ignored. It also goes through `list()`, which signs every media link of the plan, and publishing fails if the asset listing fails.

**[minor, not verified] `live.setup.ts` (#37) — Proactive audio may make Director stay silent on the app's own notes.** With proactive audio on, the model may choose not to answer notes like the greeting or shot moves. Separately, `proactivity` and `enableAffectiveDialog` go to the `v1` `LlmBidiService` endpoint; I couldn't confirm Vertex accepts them there, and the only evidence is the commit message.

## Checklist
- Tenancy: ok. Recording and your-version use `withTenant`/`tenantTx` with `orgId` from context, and there are no queue or HTTP awaits inside transactions.
- Procedures: ok. Everything new is `inOrg`, routers are thin, and Prisma is only in repositories.
- Errors: every new code has a message in `en.json` (`DEMO_GUESTS_FULL` is under auth); the stock error code is the minor finding above.
- Contract: see the `checkScene` finding. Inputs are bounded and rate-limited.
- Events/jobs: see the session-pass finding. Clip jobs are deduplicated by attempt id, use `parseJob`, and can safely run again.
- Seams: ok. Stock providers sit behind `StockProvider`, and YouTube and Gemini have their own modules.
- i18n: ok for error codes.
- Boundaries: ok. The web app only uses `@repo/contracts`.
- Environment: ok. New variables are in `env.ts`, `.env.example` and `docs/environment.md`, and production refuses the test URLs.
- Tests: missing for messages sent at socket open, notes before setup completes, adapting the same shot twice, a reconnect hitting CONFLICT, and tool-driven shot moves.
- Generated files and comments: ok.

Not checked: anything that needs a running Gemini or Vertex, and the AI service's session pass and review code beyond the review prompt.

**Verdict: not ready**