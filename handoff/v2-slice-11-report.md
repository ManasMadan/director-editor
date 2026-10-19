# Slice 11: grounded marks — report

Branch `feat/mm/v2-marks`, rebased onto `origin/master` (5e4a924, slices 1, 2 and 3 merged).
Pushed. Stack 7, now down.

## What I built

- **AI service** (`apps/ai`): `POST /v1/director/locate` (`locateDirectorTarget`).
  Gemini (`DIRECTOR_MODEL`, thinking low) gets the target in Director's words and one
  JPEG. It answers `LocateDraft` (`found`, `label`, `box_2d` as [ymin, xmin, ymax, xmax]
  on Gemini's own 0–1000 scale). `located()` turns that into `Located` (a box in
  fractions of the frame). A box with crossed edges, or one under 10/1000 on a side,
  counts as not found. Usage is booked as a new `director-locate` feature (the column is
  a string, so no migration). It reserves the scene check's budget, so there's no new env
  var.
- **Contract and API**: `director.locate` (POST `/director/locate`, `inOrg`, 60 a minute
  per user). It takes `target` (≤120) and `image` (the frame limits) and returns
  `locatedSchema`. `limits.test.ts` checks it against the AI service's schemas. Client
  hook: `@repo/client/api/director/locate`.
- **Live**: `point_at` (`target`, `label`) is in `LIVE_TOOLS`, and the browser has a new
  `not_found` result. Everything about the tool is in one seam,
  `apps/api/src/modules/live/live.marks.ts`: the declaration, argument checks, the
  not-found response, the 12 s answer window and the persona section. The relay (4 lines),
  setup (1 line) and persona (join and version bump to 3) only route to it.
- **Web**:
  - `lib/marks.ts` (pure, unit tested): `toScreen` maps a box through the 9:16 crop, then
    `object-cover`, then mirrors it for the front camera. `visibleShare` stops a mark
    being drawn when over half is off screen. `globalShift` estimates camera motion by
    block matching on 36×64 greyscale samples. `MarkBoard` holds the rules: two marks at
    most; a re-locate after a quarter frame of drift or 4 s, at most every 2 s and 10
    times a shot; fade when not found; 8 s lifetime.
  - `hooks/use-marks.ts`:
    - `point()` captures a 640 px frame and calls locate. It applies the motion since the
      capture (latency compensation) and answers `done`, `not_found`, `no_camera`, or
      `busy` if the marks were cleared while it looked.
    - It samples four times a second while marks show or a locate is in flight.
    - `useShotMarks` clears marks on a shot change, a camera flip and the start of a take.
  - `components/marks-layer.tsx`: an outline with a dark halo. The label pill is 15 px
    semibold, white on black/75, placed above, below or inside the box. It moves over
    200 ms and fades (only the fade with reduced motion). The layer is `aria-live` with
    "Director marked {label}", and never takes a tap.
  - `pages/shoot.tsx`: about 25 lines. `useShotMarks` in `useShoot`, a `point_at` branch
    in `useTools` (it answers asynchronously), `toolResult` typed to exclude `point_at`,
    and `<MarksLayer>` after the `<video>`.
- **Docs**: a "Director's marks" section and the tools table in `docs/how-it-works.md`,
  plus `docs/director.md` and the rate limit in `docs/auth.md`.

## Acceptance checks and proof

1. **Box within a finger's width.** Live check on Vertex (`gemini-3.8-flash`, two calls)
   on Chrome's fake camera frame (720×1280). For "the checkered square", the true box is
   x 0.625–0.868, y 0.625–0.875; Gemini returned x 0.625–0.873, y 0.624–0.876 (within
   about 4 px). The viewfinder mapping is unit tested. A real window on a phone is for
   UAT.
2. **Pan keeps it; pointing away fades it.** Motion tracking, latency compensation,
   re-locates, the fade when not found and hiding when off screen are all unit tested.
   Not exercised end to end in a browser.
3. **Not in view.** "The fridge" returned `found: false` live. The relay sends
   `not_found` with "Tell them you can't see it" (relay test), and the persona rule says
   to say so.
4. **Mirrored front camera.** Frames and samples are taken unmirrored, and the box is
   mirrored only when drawn. Unit tested.

## Decisions

- Box only, no point mode; for a spot, Gemini boxes the patch of floor.
- The 8 s lifetime is renewed by each successful re-locate, within 10 a shot.
- A failed locate answers `not_found` rather than drawing a guess.
- Tool calls stay blocking, so "I can't see it" is truthful. The cost is about 2–4 s
  before Director speaks after pointing.
- "Never over the face" isn't done: there's no face detector. Labels avoid the top band
  instead.
- Fast whips aren't tracked (reach is about 0.67 of a frame per second); the 4 s
  re-locate then fades the mark.

## Commits

- 207001c feat(ai): locate a thing Director names in one camera frame
- 7a29bac feat(api): director.locate and Director's point_at tool, through the relay
- a6bd000 feat(web): pin Director's marks on the picture, mapped, mirrored and moved with the camera
- c9c627b docs(docs): describe Director's marks, point_at and director.locate

## Tests and checks run

- `bun run lint` and `bun run check-types` pass.
- Unit tests pass for web 150, api 295, client 106, ai-client 16, contracts 67 and ai 219.
- Python locate integration tests (6) pass on stack 7.
- Not run (time box): browser tests for `marks-layer.tsx` and `use-marks.ts`, and e2e.

## For the controller

- Merge points: `shoot.tsx`, `live.persona.ts` (version 3), `LIVE_TOOLS` and
  `LIVE_TOOL_RESULTS`, the relay's `TOOL_RESPONSES` and its `browserCall` switch.
- Deploy: nothing new to configure. Redeploy the API and AI service together.
- Follow-ups: browser tests for the layer and hook, `point_at` in fake-google's mock
  Live, and a real-phone UAT.
