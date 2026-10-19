# Director v2, slice 12: gaps filled with stock and AI, and the saved video renders every asset

Branch `feat/mm/v2-gaps`, rebased on origin/master 3c9493c5 (#32). Head **f70d9b95**. No migration.

## What I built

### 1. The saved video renders what the plan's edit list describes (apps/web)
- `lib/scene.ts` (pure, unit-tested): what the video shows at any moment of the edit. It moves the
  edit list's times (seconds of the original) onto the member's edit through each shot's source range
  (`editTime`), then works out: the layout (full / split top or bottom with its share / picture-in-picture),
  the asset in its box (cover, or contain on a dark ground for text cards and end cards), voice-over and
  asset-mode shots (the asset full frame, the camera never shown), grades as canvas filters per target
  (camera / assets / all), asset overlays and marks (circle, underline, arrow, box, highlight, tick, cross)
  with fade/draw entries, words (title, lower third, label, callout), the end card, captions placed on a
  split's seam ("between-halves"), and B-roll gaps.
- `lib/compose.ts`: paints each frame of the render from that scene on the stitch canvas. Gap B-roll plays
  over the camera with the member's sound continuing; a still B-roll slowly pushes in; a Veo/stock clip loops.
  Never black: a skipped shot with nothing chosen holds the last camera frame (or the first take's card at
  the very start), and a moment whose asset isn't there shows the member's picture.
- `lib/stitch.ts`: takes the composer as an optional `look`, and a new `gap` segment (a skipped shot, no
  take). Match cuts from #28 still work: a moved frame is drawn onto a reused frame-sized canvas and the
  look places it. `drawCaption` takes the captions' height so they sit on the seam.
- `lib/visuals.ts`: each slot's chosen picture (the member's choice, else the slot's default, else the
  plan's default image), fetched as blobs at save time so the canvas stays recordable; an unreadable one is
  left out (its moment shows the member's picture).
- `pages/edit.tsx`: Save no longer needs every shot filmed: at least one filmed, none still being reviewed.
  Missing shots become gap segments. Shots the member's version marks as gaps (slice 4's `version.gaps`)
  now stay in the edit as gap clips the editor fills (skipped shots still drop out).

### 2. Gaps (8.7)
- AI service `app/slots.py`: every plan gets B-roll slots beside its assets: `gap-<n>` per `gap` edit and
  `shot-<n>` per shot (used when it's skipped or left as a gap). The picker's list/draw/add/choose and the
  assets job all read `slot_assets(plan)`, so stock, upload and Nano Banana stills work for gaps unchanged.
- Veo 3.1 Lite clips (`app/clips.py`, `Filmmaker`): a gap's Create tab has "Make a video clip". The row is a
  normal `created` candidate whose `model` is VEO_MODEL; the assets job makes an 8 s, 9:16, 720p, silent
  clip and stores `director-assets/<plan>/<slot>/<id>.mp4`. Limits: 3 clips a video, none for demo guests
  (DIRECTOR_IMAGE_LIMIT past it), each counted as DIRECTOR_TOKENS_PER_CLIP against the workspace allowance;
  a failed clip is never retried by itself (cost).
- Contracts: `AssetImage.media` ("image" | "video"), `draw` takes `clip`. API serves `.mp4` keys in a
  slot's folder and derives media from the key.
- Editor `components/gap-strip.tsx`: "Moments to fill", a ◇ tile per gap and skipped shot at its time,
  opening the asset picker on that slot (Upload / Create with AI incl. clip / Stock).
- Synthetic-content flag: `AssetsService.usesSyntheticMedia` (a chosen `created` video in any slot);
  publish sends `status.containsSyntheticMedia` to YouTube; the publish sheet says so before posting.
  Stock credits already flow into the description (slice 10's `stock_credits`, now over gap slots too).

## Acceptance (b5G8cbgh7K0 criteria in 8.9), and proof
| Check | Status / proof |
|---|---|
| After Done, the editor shows the B-roll gaps at the original's timing | GapStrip from `gapSlots(plan, clips)`; timing via `editTime`. Unit: scene.test.ts "lists every moment to fill in the edit's order", "cuts to a gap's B-roll at the original's timing" |
| Each gap has stock and AI options; "Generate another" adds one | Stock tab (slice 10 providers), Create tab (still or Veo clip), "Generate another" unchanged. Not auto-prefetched (see decisions) |
| Choose one per gap: the saved video cuts to them at those moments | compose.ts paints the gap's chosen picture over the camera for the gap's span; sound continues |
| Lower thirds | text edits drawn (plan's words; see decisions). Unit: "draws lower thirds, marks and asset overlays" |
| Publish lists every stock credit | slice 10 credits, now include gap slots (slot_assets in `stock_credits`) |
| Synthetic disclosure on when a Veo clip is used | youtube-upload.test.ts "declares a video with AI footage..."; publish sheet notice |
| Split / chart / captions between halves / end card (7.5 Shorts) | scene.test.ts split, PiP, voice-over, grades, end card tests |
| Never a black gap | held frame / first take's card fallback in compose.ts |
| Live Veo | One live clip through `Filmmaker` (the service's own code): 8.0 s, h264 720x1280, 2.6 MB. The first attempt (short name, API key) was refused with RESOURCE_PROJECT_INVALID before generating anything, so I address Veo by its full resource name in VEO_LOCATION=us-central1. 1 billed clip in total. |

Not verified on a phone or in a browser: the canvas painting itself (only types and the pure scene are
tested; the existing browser stitch test was not run, per the time box).

## Decisions (spec silent or time-boxed)
- Gaps are asset-picker slots with synthesized ids (`gap-<n>`, `shot-<n>`), named the same way in Python and
  the web app, rather than new plan fields: no migration, every picker source works for them at once.
- Stock is photos (slice 10's), shown with a slow push-in, not stock video; Veo covers moving B-roll.
- AI options are not prefetched at Done (the spec marks that a proposal); the member asks per gap.
- Clips count toward the 12-images-a-video limit as well as the 3-clips limit.
- Lower-third and title words are the plan's own (the original's), not rewritten into the member's words.
- An unfilled B-roll gap inside a filmed shot keeps showing the member's take (their own footage beats a
  held frame); only a skipped shot holds a frame.
- Transitions, speed ramps and the editor's live preview of layouts are not rendered yet (the saved video
  is; the player preview still shows takes and captions only).
- The picker's "Preview in your video" shows a clip candidate as a broken image (it draws an <img>).

## Commits (on origin/master 3c9493c5)
fe947b1d feat(ai): fill a video's gaps through the asset picker, with stills, stock or a Veo clip
499a3c4f feat(web): render the plan's layout, assets, grades, words, gaps and end card into the saved video
c82a9575 feat(api): declare AI footage on publish, and let a gap's Create tab ask for a clip
6deb69c2 feat(web): fill gaps in the editor and show the AI footage notice when publishing
38b857a9 test(web): cover what the saved video shows, gaps and the clip settings
7ac55466 fix(ai): reserve a clip's allowance like an image's, and keep the scene's helpers private
f70d9b95 fix(ai): call Veo by its full name in us-central1, as Vertex serves it

## Tests and checks (at f70d9b95)
- `bun run lint`: all green. `bun run check-types`: 0 errors (TS and basedpyright).
- Unit: contracts 70, client 108, web 191, api 334 passed; AI pytest 306 passed (unit).
- New: apps/web/src/modules/director/lib/scene.test.ts (11), apps/ai/tests/test_slots.py (4),
  youtube-upload.test.ts (synthetic flag), stock.test.ts (mp4 key allowed, .mov refused).
- Not run (time box): integration, browser, e2e, coverage. compose.ts, visuals.ts, gap-strip.tsx,
  clips.Filmmaker.film and the picker's clip branch have no tests yet: coverage will flag them.

## What the controller must deploy or configure
- New AI settings (defaults work): `VEO_MODEL=veo-3.1-lite-generate-001`, `VEO_LOCATION=us-central1`,
  `DIRECTOR_TOKENS_PER_CLIP=60000`. Set `VEO_MODEL=` (empty) to turn clips off. In `.env.example` and
  docs/environment.md.
- The AI worker's credentials must be allowed to call Veo in GOOGLE_CLOUD_PROJECT / us-central1 (the
  express API key in .env worked locally with the full resource name). The worker needs MEDIA_BUCKET as
  for images.
- `bun run gen` output (openapi.json, ai-client) is committed. No DB migration.
- Deploy ai (api + worker), api and web together (contract change: `AssetImage.media`, `draw.clip`).
