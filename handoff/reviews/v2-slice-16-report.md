# Director v2, slice 16 (polish): report

Branch `feat/mm/v2-polish`, rebased on origin/master 5f8d1a2f (#29, the slower line). Head: d6d48303.

## What I built (priorities 1 to 3 of 4; the blooper reel was not built)

1. **The scene check is gone.** `director.checkScene` (contract route, router, service method), the
   AI service's `POST /v1/director/scene-checks`, its agent (`_scout`, `SCENE_INSTRUCTIONS`),
   `SceneCheck`/`SceneCheckRequest`/`SceneLandmark`/`Direction` schemas, the `director-scene` usage
   feature, the ai-client method, the client hook `useCheckSceneMutation` (file deleted), the
   `director.scene_checked` activity (and its throttling and output facts), the fake Gemini's
   scene-check answers (`SceneSteps` and all), the web test stand-in's scene route, the Grafana panel's
   query, and every doc mention (README, architecture, auth, director, environment, observability,
   python-services, apps/ai/CLAUDE.md). I regenerated everything with `bun run gen`.
   Locate used the scene check's token cap, so it now has its own: `DIRECTOR_TOKENS_PER_SCENE_CHECK`
   is renamed `DIRECTOR_TOKENS_PER_LOCATE` (same default, 12000). The frame size limits stay, since
   locate uses them. No i18n keys belonged only to the scene check (slice 1 had already removed them).
2. **Conversation analytics in BigQuery.** A new analytics kind, `director_turn`, through the
   existing seam (`AnalyticsService` into `director.events`):
   - Live line: `apps/api/src/modules/live/live.turns.ts` (`TurnMeter`), fed by the relay. One row
     per turn Gemini completes: `user_id`, `video_id`, `template_id` (the plan's format), and in
     `detail`: `line: "live"`, `shot`, `input` (`voice`, `text`, or `app` for the app's notes),
     `tools` (in order), `interrupted`, `spoke`, `latencyMs` (last thing heard from the member to
     Director's first audio; slightly under for speech, since transcription lags).
   - Slower line: `apps/api/src/modules/director/chat-turn.ts`, recorded in `DirectorService.chat`
     with `line: "chat"`, `input` `said` or `app:<kind>`, `tools`, `spoke`, and `latencyMs` the
     reply's time on our side.
   - No words are ever recorded, the member's or Director's (tests check for that).
3. **Proactive audio and affective dialog** on the Live setup (`proactivity: {proactiveAudio}` and
   `generationConfig.enableAffectiveDialog`), each behind its own env switch:
   `LIVE_PROACTIVE_AUDIO` and `LIVE_AFFECTIVE_DIALOG` (zod `stringbool`, default true).
   The installed google-genai SDK maps both to these Vertex wire fields.
4. **Blooper reel: not built.** Out of time. It needs Gemini to pick the funniest discarded moments
   from the take index and a second short assembled on the media page; that's a slice of its own.

## Acceptance checks and proof

- Scene check removed: `git grep -i 'checkScene|scene-check|scene_check|SceneCheck|scene check'`
  finds nothing outside docs/superpowers and an unrelated eval test name. check-types passes for
  every workspace; `bun run lint` passes (biome, boundaries, knip, ruff format) after my fixes.
- Analytics: `live.turns.test.ts` (wait timing, tools, cut-in, reset per turn), a relay test in
  `live.test.ts` (a typed turn with a tool call and audio records the expected row, with no text
  from the member in it), `server.test.ts` (the row reaches `AnalyticsService.record` as
  `director_turn` with the right fields), `chat-turn.test.ts` (slower line shape, no words).
- Live check (one real Vertex call, project from gcloud, us-central1): with
  `gemini-live-2.5-flash-native-audio` and both `proactivity.proactiveAudio` and
  `enableAffectiveDialog` set, the setup completed and Director answered a typed turn in about 4 s
  with 17 audio chunks and a transcript ("Hello there! Is there anything specific you needed?").
  So both are on by default. A unit test checks the setup carries both only when on.

## Decisions (where the spec was silent)

- "Newest Live model": I kept `LIVE_MODEL` at the configured `gemini-live-2.5-flash-native-audio`
  (it supports both features on Vertex, proved above) rather than guess a newer name; swapping is
  one env var.
- One analytics kind, `director_turn`, for both lines, with `detail.line` telling them apart, so one
  Looker query covers the conversation.
- `template_id` is the plan's `format` (what the short is), as nothing else names a template today.
- Renamed the token cap env var instead of keeping a misleading name.

## Commits (on origin/master 5f8d1a2f)

- cc794402 refactor(api): remove the scene check nothing calls any more
- 71b008e6 feat(api): record each of Director's live turns in BigQuery
- 9f946851 feat(api): Director live uses proactive audio and affective dialog
- 8e3b3f28 chore(api): regenerate the AI client and tidy lint after rebasing on master
  (the rebase left conflict markers in two generated ai-client files inside cc794402; this commit
  regenerates them, so squash-merge or keep both together)
- d6d48303 feat(api): record the slower line's turns in BigQuery too

## Tests run

- Unit: @repo/contracts 67, @repo/ai-client 17, @repo/fake-google 32, @repo/client 106,
  @repo/api 328 (all pass, after the rebase).
- check-types: all workspaces pass. lint: passes.
- Python: the touched AI tests are integration tests; on the shared Postgres they fail before reaching
  my code (`ai.demo_guest_workspace(uuid) does not exist`: that database is behind master's
  migrations). Not run on a stack of my own, per the time box. ruff check/format pass.

## For the controller to deploy or configure

- Env: `DIRECTOR_TOKENS_PER_SCENE_CHECK` is now `DIRECTOR_TOKENS_PER_LOCATE` (ai). Nothing in deploy
  set the old one; a local `.env` that still has it is ignored (extra="ignore"), doctor may flag drift.
- New api env (optional, default true): `LIVE_PROACTIVE_AUDIO`, `LIVE_AFFECTIVE_DIALOG`. Set either to
  false if a future `LIVE_MODEL` refuses it at setup (Vertex closes the socket; the logs say
  "live upstream closed").
- BigQuery: no schema change; `director_turn` rows use the existing `events` columns (detail is JSON).
- Grafana: the Director dashboard's "Takes and scene checks" panel is now "Takes and reviews".
- CI to watch: the AI integration tests touched (test_director, test_service, test_budgets) and
  apps/api's director integration test (scene-check case removed).


## Update: rebased on origin/master 943b9dcf (slices 15, 4, 5, 8+14, 12). Head b0e3e396.

- Conflicts resolved keeping both sides: slice 4's memory-aware instruction (`version`), slice 5's
  `rate` tool and picks block, the slower line, and the editor and asset calls all stay; the scene check
  is removed from everything new too (create.py's brainstorm budget now uses
  `director_tokens_per_locate`). Proactive audio and affective dialog sit on top of the picks persona in
  the Live setup; director_turn sits beside the relay's picks and tally.
- `rate` calls now count in a live turn's `tools`.
- Fixed a type break that came in with master itself: `createAiClient` merged five groups of calls with
  Object.assign, whose typing stops at three sources and returns any, so apps/api's check-types failed
  (library, takes, cuts, media typed unknown). The last two groups are nested now, with a type test in
  packages/ai-client. I also un-exported four unused editor exports in packages/contracts and one type in
  apps/web, which knip flagged on master.
- Checks after the rebase: `bun run gen` in sync, `bun run check-types` passes, `bun run lint` passes;
  unit tests: api 350, ai 322 (pytest unit), ai-client 18, contracts 70, client 106, fake-google 33.
