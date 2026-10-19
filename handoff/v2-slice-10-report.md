# Director v2, slice 10: the asset picker (and slice 9's "What you'll need")

Branch `feat/mm/v2-asset-picker` from `origin/feat/mm/v2-assets` (cf8909c), pushed. No PR.
Stack 6 (`bun run db:down` done at the end).

## What's built

**Data** (migration `20261018210000_director_asset_picker`, expand only)
- `ai.director_asset` grows from "a plan's defaults" to "every image of a slot": origin
  `default | created | upload | stock` (check widened NOT VALID then validated), new
  nullable `prompt`, `reference_key`, `base_id`, `file_id`, `credit` (JSONB).
- New `ai.director_asset_choice` (RLS, `app_ai` SELECT/INSERT only): the newest row per
  (plan, member, asset) is the slot's image, older rows are its history (undo). A null
  candidate means the default.
- `ai.images_today` now counts only drawn images (default, created): uploads and stock
  cost nothing.

**AI service** (`app/picker.py`, `app/assets.py`, routes in `app/main.py`)
- `GET /v1/director/plans/{v}/assets`: every slot with `prompt` (the Create tab's
  pre-fill: the asset's prompt held to its reference's style, palette, composition,
  black and white and text in quotes, branding replaced), its default and the caller's
  own images, `chosenId`, `history`, and images used/left (video and day).
- `POST .../assets/{a}/drawings`: queues a `created` row (prompt, optional upload as
  reference, or `baseId` + instruction for an edit), within 12 images a video (5 for a
  demo guest; the member's own defaults count) and 30 a day, under the same advisory lock
  as the defaults (`DIRECTOR_IMAGE_LIMIT` past them). Stills only.
- The `assets` job now draws `created` rows too: the reference photo or the image being
  edited is read back from `MEDIA_BUCKET` and sent with the prompt (Nano Banana image to
  image); stored at `director-assets/<plan>/<asset>/<row>.png`.
- **Spelling check**: after each drawing (defaults included) Gemini (`DIRECTOR_MODEL`)
  proofreads the image against the quoted text; a misspelt image is drawn once more with
  "spell every word exactly as quoted" before it's shown. A proofreader failure never
  blocks the image. Both drawings settle in the same `director-asset` reservation.
- `POST .../images`: records an upload or stock picture the API already checked/stored.
- `POST .../choice`: picks a ready image of the slot (default or the caller's own).
- `publish_copy`: the credits end with a line per stock photo the member's video uses,
  "<asset title>: <author> on Pexels (<page link>)" (`PUBLISH_CREDITS_MAX_LENGTH` and the
  Python twin raised 300 → 2000; the original's credit still capped at 300).

**API** (new module `apps/api/src/modules/assets/` with `stock/`, new `assets` contract)
- New contract namespace `assets`: `list`, `draw`, `addUpload`, `addStock`, `choose`,
  `searchStock`, each rate limited (drawings 40/h, stock searches 60/h, copies 60/h).
- New error codes `DIRECTOR_IMAGE_LIMIT` (429) and `DIRECTOR_ASSET_NOT_FOUND` (404), with
  messages.
- Upload purpose `director-asset-image` (JPEG/PNG/WebP, 15 MB): the worker scans it as
  every upload, then re-encodes it at most 2160 px long side, PNG when it has alpha
  (cutouts) else JPEG, metadata stripped.
- **Stock seam** `stock/stock.ts` (`StockProvider` interface, `StockLibrary`: interleaved
  results, 24 h cache, copy by provider id only, never a client URL; image host allowlist,
  15 MB cap) and `stock/providers.ts` (Pexels, Pixabay with safesearch). Feature `stock`
  in `system.info`, on when `PEXELS_API_KEY` or `PIXABAY_API_KEY` is set; the Stock tab is
  hidden otherwise. `PEXELS_API_URL` / `PIXABAY_API_URL` are test hooks, HTTPS-only in
  production. Documented in `docs/environment.md` and `.env.example`.
- Every image link is signed only when its key is the slot's own folder
  (`director-assets/<plan>/<asset>/<uuid>.png|jpg`) or the upload's own `files/<id>`.

**Client** (`packages/client/src/api/assets/*`, one hook per file) and realtime: a
`director.changed` nudge also refetches the slots; a 5 s poll while an image is drawing.

**Web**
- `components/what-you-need.tsx` on the template page: who's on camera (on camera /
  voice only / both / nobody), about how many minutes, "Director makes for you" (each
  asset with its default image or "Director's still drawing this one", "your own topic,
  if you like", and a Change button opening the picker for stills), and "The editing"
  (split screen, word-by-word captions, end card...) as a localised list.
- `components/asset-picker.tsx`: one sheet, three tabs (Upload, Create with AI, Stock
  when on), the suggested one first (Upload when the plan asks for the member's photo,
  Stock for stock-default assets, Create otherwise). Create: the pre-filled prompt,
  "Add your photo as reference", Create, results grid with Director's version and the
  member's, "Generate another" tile, "make it moodier" edit of the selected image,
  images left. Upload: the "Only upload things you have the right to use." line. Stock:
  search pre-filled from the reference's subject, orientation from the slot's box,
  "Jane Doe on Pexels" on each, copy on tap. Footer: "Preview in your video"
  (`slot-preview.tsx`: a 9:16 frame with the candidate placed in its box by the edit list,
  cover or contain, the template's grade as a CSS filter, the camera's place with the
  original's storyboard, the caption position), "Use this", Undo.

## Acceptance (spec 8.9) and proof

| Check | Status |
|---|---|
| Pre-filled prompt from the chart's reference | Done: `slots()` returns `picker_prompt`; `test_a_slot_starts_from_the_original_s_reference` |
| "about the 12 types of coffee drinkers" puts that title on it, spelt right | Done through a prompt edit or the edit box; text in quotes is proofread and redrawn once when misspelt (`test_a_misspelt_image_is_drawn_once_more`). Live quality not checked (no Vertex calls made) |
| Generate another gives a different version | Done (a fresh drawing of the same prompt); visible difference relies on Nano Banana's sampling, not checked live |
| "make it moodier" edits it | Done: image to image from the selected image (`test_an_edit_draws_from_the_image_it_changes`) |
| Upload a photo: fills the slot without distortion, graded like the template | Upload + choose done (`test_uploads_and_stock_are_kept_and_chosen_with_their_history`); the preview shows it covered/contained and graded. **Not in the saved video**: see below |
| Stock: Pexels and Pixabay results with creators' names | Done behind keys; tested against a local stand-in (`stock.test.ts`). No keys yet, so not live |
| The chosen stock credit appears in the publish sheet's description | Done: `stock_credits` → `tidy(stock_credits=...)` (`test_a_post_credits_each_stock_picture_the_video_uses`, `test_the_credits_end_with_a_line_for_each_stock_picture`) |
| Limits: 12 a video, 5 demo, 30 a day | Done (`test_drawing_stops_at_the_video_s_limit_and_the_demo_s`); the Create tab says how many are left and the API's message when out |
| What you'll need (slice 9) | Done on the template page (`picker.test.ts` for the derivation) |

## Not done, for the controller

1. **The saved video doesn't render the chosen asset yet.** The editor's renderer
   (`lib/stitch.ts`) doesn't apply slice 9's edit list on this base (slice 9 shipped the
   server side only). The choice is stored server-side and `slotPlacement()` already
   computes the box, fit and grade the renderer needs; whoever builds the editor's edit
   list should draw `slots[].chosenId` (or the default) with `slotPlacement`. Also no
   picker entry in the editor or the shoot yet: the template page is the entry point
   (the component takes `videoId`, `plan`, `asset` and drops in anywhere).
2. **Stock needs keys**: `bun run env:set PEXELS_API_KEY=...` / `PIXABAY_API_KEY=...` on
   the API (and the production secret store). Nothing else to configure.
3. Clips (B-roll uploads, Veo, stock video) are slice 12: uploads and stock are photos.
4. Imagen for photo-real references isn't wired: everything draws with Nano Banana.
5. "Results with recognisable logos are skipped": only Pixabay's safesearch and the
   no-logos prompt line; no logo detection on stock results.
6. Spell-check tokens are settled in the image's reservation under `ASSET_MODEL`'s name.
7. Not run (time box): browser tests (web `test/`), e2e, coverage, API integration tests
   for the new procedures (the AI side is covered by integration tests; the API side by
   unit tests of the stock seam and the key rule only).
8. The first commit of slice 9 is still typed `wip(ai)`; squash on merge.

## Decisions

- One table for every image of a slot plus an append-only choice table: history and undo
  for free, defaults stay shared and the member's own stay private.
- Drawn images go through the existing `assets` job (ledger, retries, realtime) rather
  than a synchronous call, so the picker shows them landing like the defaults.
- A new `assets` contract namespace instead of more `director.*` procedures, to keep the
  merge with the other slices' director changes small.
- The default image of a seeded template has no row, so it can be chosen but not edited;
  the edit box appears for a user plan's default and every drawn image.
- The demo flag comes from the API (`context.demo`), as there's no guest flag in the AI
  service on this base.

## Checks (stack 6, then `bun run db:down`)

- `bun run lint`: pass (after the fixes: Prisma format, suppression row for the
  migration, knip, one hook per file, function length).
- `bun run check-types` (22 tasks): pass.
- Unit: api 272 (incl. 8 stock seam + env refusals), web 216 (incl. 8 for What you'll
  need and the preview placement), client 86, contracts 54, i18n 11, ai-client 13,
  worker 15, ai 254 (incl. the credit lines): pass. Two env tests in api/worker and a
  nest-common storage test failed only under the full parallel run and pass alone.
- AI integration: `test_picker.py` 11 passed; `test_assets.py`, `test_director.py`,
  `test_models_match_db.py`, `test_publish_copy.py` 94 passed.
- `bun run --filter @repo/db drift`, `bun run db:lint` (Squawk): clean. `bun run gen`
  committed (openapi.json for api and ai, the AI client, error codes).

## Commits

ccbbe6e, 9a4eb7b, a3b5a6f, 67d4d7d, e71fd8f (on top of slice 9's cf8909c).
