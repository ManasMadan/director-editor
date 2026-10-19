# Director v2, slices 8 + 14: report

Branch `feat/mm/v2-editor-talk`, head `1242b7f3`, rebased on origin/master `aa7b0868` (#31).
Worktree: `/Users/manas.madan/Desktop/code/director-editor.feat-mm-v2-editor-talk` (made with
`wt switch` after the first agent worktree disappeared during the session limit).

## What I built

### Slice 8: the take index, and finding a take by description
- **The take index, written at review time** (same Gemini 3.8 Flash call as the review).
  `TakeReview` gains `index: TakeIndex` (apps/ai/app/schemas.py): `visible` (people,
  clothing, place, background objects, actions, expressions), `things` (each object in 2-3
  words), `transcript` (every word with start and end), `moments` (laugh, smile, blink,
  look-away, stumble, pause, gesture with times), `quality` (sharpness, shake, exposure,
  audio). `REVIEW_INSTRUCTIONS` asks for it. It is stored in a new nullable JSONB column
  `ai.director_take.take_index` (migration `20261018230100_director_take_index`, Prisma +
  SQLAlchemy model). Older takes read as null.
- **Finding by description**: the editor brain (below) reads every take's index and
  answers one match (applied, a `pick_take`), several (outcome `ask`, candidates in
  `choices` with the moment and why) or none (`no-match`, the closest one or two in
  `choices`). Nothing changes on ask/no-match: the server strips actions unless the
  outcome is `applied` (`reply_of` in apps/ai/app/editor.py), so a wrong match can't swap.

### Slice 14: the conversational editor
- **AI**: `POST /v1/director/editor-requests` (`askDirectorEditor`), `Director.edit` in
  apps/ai/app/director.py, prompt and context in the new apps/ai/app/editor.py. Gemini gets
  the shots (title, length, script), each shot's takes numbered oldest first ("try 2, 2:00
  in", score, feedback, kept range, index) and the current edit (takes playing, in/out,
  order, drops, grades, captions, voice, music, caption fixes), plus the typed text or the
  spoken audio (sent as audio to Gemini; no browser transcription). It answers through
  Pydantic AI's output tool (`final_result`, i.e. a tool Gemini calls) with `EditorDraft`:
  heard, outcome (applied / ask / no-match / declined / confirm / answer), a one-line
  `say`, edits and choices. Shots and takes are numbers in the draft (Gemini gets those
  right); the server maps them to shot indexes and take ids and drops edits naming
  anything that doesn't exist. Budget: reserves a take review's budget under the new
  usage feature `director-editor`; activity line `director.editor_request`.
- **Edits (the spec's tools)**: `pick_take`, `trim` (absolute in/out from word times and
  moments, so "end shot 2 on the smile" and "make it snappier" are trims), `move_shot`,
  `swap_shots`, `drop_shot`, `restore_shot`, `captions` (pop / classic / off),
  `edit_caption` ("it's 'Claude', not 'cloud'"), `set_grade` (per shot or all),
  `set_volume` (voice on/off; music level), `asset_request`, `reset_to_picks`, `undo`,
  `redo`, `reshoot`. Out of reach ("remove the guy behind me") is `declined` with an
  alternative; costly or destructive is `confirm`, no edits.
- **API seam**: new contract namespace `editor` (packages/contracts/src/api/editor.ts,
  `editor.ask`, POST `/director/{videoId}/editor-requests`, 30/min per user) and module
  apps/api/src/modules/editor (module, service, router). Client hook
  `useAskEditorMutation` (packages/client/src/api/editor/ask.ts).
- **Web**: the "tell Director" bar under the shot board
  (components/tell-director.tsx): text field, send, and a mic (MediaRecorder; tapping it
  pauses the preview, tap again to stop and send). Director's line shows above it in an
  aria-live region with **Undo** when it changed something; several/none matches show the
  candidates as looping inline previews to tap (tapping applies the pick). Each applied
  answer is **one step in the edit history** (one Undo, also the transport's undo). The
  changed shot is outlined on the board (`ShotBoard` `highlight`), scrolled into view and
  the preview seeks to it. lib/editor-actions.ts applies actions (`APPLY` table) and
  arranges the edit (order, drops, trims, grades, caption fixes); lib/grades.ts gives each
  grade one filter string used both as the preview's CSS filter and the render's canvas
  filter (lib/stitch.ts), so the saved video matches. Dropped shots are left out of the
  saved cut's picks and the video.

## Acceptance checks and proof

Live Gemini wasn't called (cost, time box), and no browser/e2e run (shared machine).
What's proven by tests:

| Check (9.6 / UAT 8, 14) | Proof |
|---|---|
| One match swaps, says so, highlights, Undo restores | `reply_of` maps "shot 1 take 1" to the take id (test_editor.py `test_an_applied_answer...`); `applyActions` pick + one history step (editor-actions.test.ts); highlight/Undo wiring in edit.tsx |
| Several match: asks with both previews, tap applies | `test_nothing_changes_until_the_member_chooses` (choices kept, actions stripped for ask/no-match/declined/confirm/answer); `Choice` previews in tell-director.tsx load through `useTakeMedia` (candidate clips) |
| None: says so, shows closest, nothing changes | same test |
| "end shot 2 on the smile" | prompt maps it to `trim` endSeconds = smile moment + 0.3; `trim` tests (keeps the other point, refuses < 0.5 s) |
| "make it snappier" shortens; one Undo | prompt: one trim per shot; all actions one history step |
| "captions off" and "undo" round-trip | `captions` and `undo` effect tests |
| black and white intro, swap shots, back to picks, 'Claude' fix | `set_grade`, `swap_shots`, `reset_to_picks`, `edit_caption` + `fixLines` tests |
| "remove the guy behind me" declined | prompt `declined` rule; server strips edits on declined |
| Context Gemini reads (index, try numbers, edit) | `test_gemini_reads_every_take_with_its_index_and_the_edit` |

Needs the owner's UAT on a phone with a live model: the ~3 s feel, match quality, voice.

## Decisions (spec silent or time-boxed)
- Structured output via Pydantic AI's output tool rather than one Gemini function per
  tool: one round trip (keeps the ~3 s budget) and validated edits; the edit names match
  the spec's tools.
- Shots/takes by number in Gemini's answer, ids mapped server-side.
- Voice is the recording sent to Gemini 3.8 Flash with the request, not Gemini Live in the
  editor (spec says Live): far less to build, same model brain; Live can replace it behind
  `useTellDirector`.
- The keyframe re-check of visual claims ([proposal]) and Vertex embeddings for "closest"
  are not built: Gemini ranks closest from the index; matches are only what the index
  says, and nothing changes without a single match.
- Budget: an editor request reserves a take review's budget (no new env var).
- Music: the editor has no soundtrack today, so "quieter music" gets Director's line and a
  `music` effect the page ignores; "different soundtrack" / "another option" are an
  `asset` effect with Director's description. `repeat_shot`, `add_gap`, `fill_gap`,
  `place_asset`, `compare`, `set_length` aren't separate edits (`set_length` is a trim).
- Match cuts (from #28) apply only while shots play in the plan's order with none
  dropped; once the member reorders or drops, cuts are plain.
- Caption fixes are whole-word, case-insensitive replacements over the shot scripts the
  captions come from.

## Where other slices join
- **Asset picker (slice 10)**: `effects.asset` / `effects.music` in `useTalk`
  (apps/web/src/modules/director/pages/edit.tsx) receive Director's description: open the
  picker on that slot there. Server-side shortcuts go in `EditorService.ask` before the AI
  call, returning the same `EditorReply`.
- **Picks with reasons (slice 5)**: the index lives beside the review; if slice 5 adds a
  `reason` to `TakeReview`, both fields coexist (expect a small merge in schemas.py,
  director.py's review update, models.py and ai.prisma).
- New editor actions: one entry in `editorOps` (contract), `EditorOp` (schemas.py), the
  prompt, and `APPLY` (lib/editor-actions.ts).

## Commits (all pushed)
- f69fbed0 feat(ai): index every take as it's reviewed and answer requests in the editor
- 34074609 feat(web): tell Director what to change in the editor, typed or said
- fe15393d test(web): cover the editor's actions, its arranged edit and Director's answers
- 89d0335c fix(web): keep the editor's functions short, regenerate the clients after rebasing
- 1242b7f3 chore(db): run the take index migration after the created-Shorts one, regenerate the AI client

## Checks run
- `bun run check-types -- --continue`: everything passes except `@repo/worker`, which fails
  on master too (`BodyInit` / `RequestInfo` in packages/ai-client under the worker's
  tsconfig; untouched by this branch). `@repo/ai` basedpyright: 0 errors.
- `bunx biome check apps packages`: clean. `ruff check` / `ruff format` on apps/ai: clean.
- Unit tests: web 188, api 324, contracts 67, client 108, i18n 11 passed; AI
  `tests/test_editor.py` + `tests/test_units.py` 39 passed.
- Not run (time box): integration (incl. apps/ai `test_models_match_db.py` and the DB-backed
  review tests), browser tests (`test/director/use-edit-history.test.tsx` fixture updated
  but not run), e2e, coverage.

## For the controller to deploy or configure
- Apply the migration `20261018230100_director_take_index` (nullable JSONB, no rewrite).
- Deploy apps/ai, apps/api and apps/web together (new AI route, new API namespace).
- No new env vars. Takes reviewed before this deploy have no index: Director can still
  find them by number, time and score, but not by what's visible until they're reviewed
  again (or re-shot).

## Update: rebased on slice 4 (master 3c9493c5), head e87b3c32
- Kept both sides everywhere: the AI service's re-planning route and schemas, the
  `director-revise` and `director-editor` usage features, and in edit.tsx slice 4's version
  (only filmed shots reach the edit, adapted shots, `VersionGaps` on the board) together
  with slice 13's match cuts and the editor's arrangement (`useArrangedClips`).
- Since skipped shots are now left out of the clips, lib/editor-actions.ts finds clips by
  shot index (`clip.index`), not by position (`playOrder` takes the shots there are).
- The editor's AI call has its own group in packages/ai-client (`editorCalls`), keeping
  Director's group under the 60-line rule.
- Checks: Biome and ruff clean; check-types passes everywhere except `@repo/worker`
  (fails on master too); `@repo/ai` basedpyright 0 errors; unit tests web 192, api 333,
  contracts 70, client 108, AI 39 passed.

## Update: rebased on slice 5 (master 19e9745d), head df825596
- Kept both: slice 5's `reason`, `chosen_at`, `origin` columns and its review reason with
  the take index (one review prompt asks for the reason, then the index); the
  `director-pass` and `director-editor` usage features; its picks UI (`BackToPicks`) in the
  board panel next to the tell Director bar.
- Slice 5 added a `TakeChoice` model to the AI service, so the editor's answer choices are
  now `EditorChoice` (AI schema and generated client).
- Commits with conflict markers were folded into one clean commit before pushing.
- Checks: Biome and ruff clean; check-types passes except `@repo/worker` (fails on master
  too); `@repo/ai` 0 errors; unit tests web 195, api 343, contracts 70, client 108, AI 39.
