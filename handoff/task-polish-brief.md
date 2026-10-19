# Polish batch: show the seed media, and the review follow-ups

One implementer, one branch. Each item is small; do them in order, TDD where there's
behavior, every string through i18n, Gemini loaders for waits.

## 1. Show the seed media on the template page (the main item)

Task 2.6.3 generated, for each of the 6 seed templates, a Nano Banana storyboard card and a
Veo preview clip per shot and a Lyria music track per seed, and `director.plan` now returns
signed links for them on seed plans only (read packages/contracts/src/api/director.ts and
apps/api/src/modules/director for the exact field names and shape; the library and the
index answer carry no media links on purpose). The web shows none of it yet.

- Template page (apps/web/src/modules/director/pages/director.tsx and
  components/shot-list.tsx): on each shot card, show the storyboard card image (lazy,
  alt text from the shot's title/scene) and let the member play the shot's preview clip
  (tap/click to play inline, muted, looped, `playsInline`; no autoplay of every clip at
  once — at most the one in view or the one tapped). Label it honestly: "Storyboard by
  Nano Banana" / "Preview made with Veo" (i18n). A user's own plan has no media: the
  cards look as they do today.
- The seed's Lyria track: a small "Soundtrack, made with Lyria" player on the template
  page (play/pause, labelled), for seeds that have one.
- The links expire: if a media element errors (expired signed URL after a long idle),
  refetch the plan once rather than showing a broken image.
- Tests: a component/page test that a seed plan with media renders the card images and a
  playable preview; a user plan renders none; i18n keys present.

## 2. Landing page's Google Cloud list

apps/web/src/modules/marketing (the `SERVICES` list and its i18n): now add the services
that are live: Veo, Lyria and Nano Banana ("in the seed templates": storyboard cards,
preview clips, soundtrack), Gemini text-to-speech (Director's voice on the shoot screen),
Cloud Run (the private indexer — it's deployed at ship time; include it, the controller
deploys it today). Keep every line factual; update the landing's unit test.

## 3. Review follow-ups (each small)

- TTS (apps/web/src/modules/director/lib/speech.ts): add `audio.onerror`/`onabort` that
  clear `playing` and `current` when `playing === audio`, with a test. Warm the cache
  when the shoot page opens: request the plan's first few guide lines in the background
  (the speak endpoint stores them, shared across workspaces) so the first cue isn't the
  browser voice — keep it to the first shot's lines to bound cost, and only off a live
  call.
- packages/ui GeminiLoader inside a <button> renders a <div>: give it an `as="span"` (or
  render a span) variant and use it in directors-cut.tsx's button. Story/test updated.
- director.tsx: the template page's h1 uses `truncate`: use `line-clamp-2`.
- apps/web/test/director/director.test.tsx:932: move `vi.restoreAllMocks()` to an
  `afterEach`.
- Editor (apps/web/src/modules/director/pages/edit.tsx `upload`): check `signal.aborted`
  before showing the Saved dialog; and in packages/client/src/api/director/save-cut.ts
  document that a cancel after completeUpload leaves a checked file with no cut (the
  worker's cleanup removes pending files after 24 h; a ready director-cut-video with no
  cut is a known leftover) — or, better, if the files contract has a delete, call it on
  cancel after completeUpload.
- apps/ai/app/indexing.py `index_short`'s `drafted` callback: say in its docstring that
  it must not raise (it runs inside the planner's retry), or call it outside that try.

## Checks

lint, check-types, unit, the web browser tests for what you touched, ai tests if you
touched apps/ai, `bun run gen` drift-free. Use playwright-cli (-s=polish) to look at a
seed template page with its media on your stack (seeded workspace: sign up; set your
stack's storage to read the real GCS bucket only if the controller says so — otherwise
verify with the component test and a screenshot of the cards' layout).
