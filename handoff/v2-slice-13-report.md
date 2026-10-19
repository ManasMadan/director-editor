# Slice 13: aligned match transitions (spec 9.5): report

Branch `feat/mm/v2-match-cuts`, from `origin/master` (e8526d9), pushed. Worktree:
/Users/manas.madan/Desktop/code/director-editor.feat-mm-v2-match-cuts (made with `wt switch` after the
first worktree vanished at the session reset). No stack: only unit tests ran, per the time box.

## What I built

**AI service (apps/ai)**
- `app/aligning.py`: the alignment. ffmpeg reads the outgoing take's last 0.5 s and the incoming take's
  first 0.5 s at 15 fps, each fitted to the 9:16 output frame the way the renderer does (cover, centre
  crop) at 360x640. Gemini (`DIRECTOR_MODEL`) boxes the anchor in the two boundary frames. OpenCV
  refines it: multi-scale template matching seeds ECC (`findTransformECC`, affine, reduced to
  translation + scale + rotation) on the anchor patch; the anchor is tracked through both half seconds
  and the cut moves to the frame pair whose anchor velocities match best (both still, or moving the same
  way), trimming as little as it can. The incoming clip's transform puts its anchor exactly where the
  outgoing one left it, and the anchor is measured again on the aligned frame (the "Check the cut"
  offset). Answers `not-found` (identity, cut where asked) when Gemini can't see the anchor in both, or
  when nothing near Gemini's box looks like the anchor.
- Seam: `Aligner` with `LocalAligner` / `RemoteAligner` (ALIGNER_URL), the indexer's pattern.
- `app/aligner.py`: Cloud Run entrypoint (`uvicorn app.aligner:app`), `AlignerSettings`
  (ALIGNER_URL, ALIGNER_INVOKER, DIRECTOR_MODEL, Gemini settings), ID-token check like the indexer.
- Route `POST /v1/director/match-cuts` -> `Director.align_match_cut`: reserves tokens
  (`director-align`, DIRECTOR_TOKENS_PER_ALIGNMENT, default 12000), runs the aligner, settles usage.
- Deps: `opencv-python-headless`, `numpy` (uv.lock updated; the ai image already has ffmpeg).

**API, contracts, client**
- Contract `director.alignMatchCut` (`POST /director/{videoId}/match-cuts`, 60/hour/user): two take ids
  with cut points and the anchor; answer `matchCutAlignmentSchema`. The service checks both takes are the
  caller's ready videos (DIRECTOR_TAKE_NOT_FOUND), presigns their reads and calls the ai service.
- `@repo/ai-client` `director.alignMatchCut`; `@repo/client` `useMatchCutAlignments` (useQueries, kept for
  the session, no retry).

**Editor (apps/web)**
- `lib/match-cuts.ts` (pure): finds match cuts in the plan's edit list (a `transition` edit of kind
  `match-cut` at a shot's start in the original, read structurally so it works once slice 10's `edits`
  merge; with today's plans there are none), builds the asks, moves cut points (`alignClips`), CSS form of
  the transform.
- `hooks/use-match-cuts.ts`, `components/match-cut.tsx`: "Aligned for you" note per cut ("the watch stays
  put into shot 2: 1 px off at the cut (was 72 px)") with **Check the cut**: onion skin (last frame before,
  first frame after aligned at 50%), crosshair on the anchor, the offset and whether it's within 8 px.
  Aligning / not-found / failed states; aria-live.
- `lib/stitch.ts`: video segments take an optional transform; the render draws a blurred copy of the frame
  underneath (so edges the move uncovers aren't black) and the transformed frame over it.
  `components/edit-player.tsx`: the preview applies the same transform in CSS.
- `pages/edit.tsx`: small seam: `useEditor` runs `useMatchCuts`, passes transforms to the player and the
  render, and shows `<MatchCutNotes>` above the shot board.

**Shoot (apps/web)**
- `components/match-ghost.tsx`: when the cut into the current shot is a match cut, the last frame of the
  previous shot's take (its pick, else the newest ready video; the kept part's end) at 35% opacity over the
  camera, mirrored like the preview, with "Line up {anchor} with the faint picture".
- `pages/shoot.tsx`: one line, `{started ? <MatchGhost {...shootProps} facing={camera.facing} /> : null}`.

**Docs**: docs/deploy.md "The Cloud Run aligner"; docs/environment.md and .env.example for the 3 new vars.

## Acceptance (spec 9.5) and proof
- "Watch moves at most 8 px at the cut; a wrist 60 px off on purpose still lines up":
  `apps/ai/tests/test_aligning.py::test_a_wrist_60_px_off_lines_up_within_tolerance`. Real MP4 footage
  (a textured watch on unrelated backgrounds), incoming watch 60 px right and 40 px up in the output frame
  (72 px), 6% bigger, turned 2.5 degrees, Gemini's boxes deliberately off by 1%. Checked against ground
  truth: the returned transform lands the drawn watch centre within 8 px of the outgoing one, scale
  within 3%, rotation within 1.5 degrees; offsetBefore about 72 px, offsetPx <= 8, withinTolerance.
  In my run: offset 0.0 px after alignment, scale diff 0.0004, rotation 0.01 degrees.
- Canvas and CSS transforms are the same maths: `lib/match-cuts.test.ts` ("the transform").
- Not checked: a real phone UAT (the spec's 15) and a live Vertex call: the local .env has no Vertex
  project, so Gemini ran only against the local Gemini fake.

## Decisions (where the spec was silent or I deviated)
- No extra zoom to cover the frame after aligning: zooming grows the anchor past the 3% scale tolerance. The
  renderer fills edges a move uncovers with a blurred copy of the same frame instead. `cropPercent` reports
  how much of a side is uncovered or cut (about 15% for the 60 px case, over the spec's 10%; a fill, not a
  crop of the watch). The preview shows those edges dark (no blur), the saved video blurred.
- The transform holds for the whole incoming clip (no ease back to identity): the spec's "if the original
  does" can't be known from the plan yet.
- The ghost is shown automatically for a match-cut shot rather than via a `show_ghost` Live tool, and
  without the anchor outline or the live "40 px left" offsets to Director. Those need the Live tool set
  (contracts/live, the relay, fake-google) that other slices are changing; a clean follow-up.
- Alignment is synchronous (API -> ai, under the ai client's 30 s); `ALIGN_REQUEST_SECONDS` is 27 s.
- Nothing is stored: the editor asks again per session (the query is kept for the session).

## Tests run
- apps/ai: ruff, basedpyright (0 errors), unit tests 219 passed (13 new in test_aligning.py).
- contracts 57, ai-client 14, client 87, web 132, api 272 unit tests: all pass. check-types for web,
  api, client, contracts, ai-client: pass. `bun run lint` (incl. knip, boundaries): pass.
- Not run: integration (no API integration test for `alignMatchCut` against storage; the route has no
  test against the database for `align_match_cut` usage accounting), browser tests for the note and
  ghost components, coverage.

## Commits
See `git log origin/master..feat/mm/v2-match-cuts`.

## For the controller to deploy / configure
- Merge after slice 10 (plan `edits`) for match cuts to appear; nothing breaks before it.
- The ai image grows by OpenCV + NumPy (about 60 MB). The ai pod aligns in-process until ALIGNER_URL is set.
- Optional Cloud Run aligner: follow docs/deploy.md "The Cloud Run aligner" (service account with
  aiplatform.user, deploy with `--command=uvicorn --args=app.aligner:app,...`, run.invoker for the VM),
  then set `ALIGNER_URL` on the ai service in deploy/environments/production/stack.yaml.
- Gemini 3.8 Flash: the aligner uses DIRECTOR_MODEL; set it to `gemini-3.8-flash` (or whatever production
  runs) on the Cloud Run service to match the ai service.
- Worth one live check on Vertex: open the editor on a match-cut template with two takes.
