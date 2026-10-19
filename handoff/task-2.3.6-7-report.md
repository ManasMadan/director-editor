# Tasks 2.3.6 + 2.3.7 report: timeline editor and My media

Status: DONE_WITH_CONCERNS (concerns at the end; none block the feature)

The worktree guard wouldn't let me write the report at the shared path, so it's at the same relative path inside my worktree:
`/Users/manas.madan/Desktop/code/director-editor/.claude/worktrees/agent-af07a49b134306914/.superpowers/sdd/2026-10-18-director-hackathon/task-2.3.6-7-report.md`.
The screenshots are in both places (`…/screenshots/task-2.3.6-7/`). Neither the report nor the screenshots are committed.

Branch: `worktree-agent-af07a49b134306914`, based on `origin/feat/mm/director-hackathon` (2afae69).
Stack: 9 (`bun run setup --stack 9`), stopped with `bun run db:down` at the end.

## Commits (range `2afae69..d266c2d`)

```
d266c2d fix(web): keep a shot's take stepper at the top of its column
60f7a95 refactor(web): drop the editor's unreachable branches and check My media's captions
a2cfc5b test(web): pin the editor's save flow and give its captions to My media's player
cb2c1b3 feat(web): edit takes shot by shot and save the video to My media
8fa6cae feat(client): add hooks for a short's shots, saving a cut and My media
```

## What changed and why

### packages/client (hooks land with their pages)
- `api/director/shots.ts`: `useDirectorShotsQuery(videoId, enabled)`. Polls every 3 s while any take is pending or being reviewed, because the review sets the pick.
- `api/director/save-cut.ts`: `useSaveCutMutation`. It uploads through the existing files flow (`uploadFile`: presign → PUT → completeUpload), waits for the worker's check, then calls `director.saveCut`, and invalidates `director.media`.
- `api/director/media.ts`: `useDirectorMediaQuery`. Polls while a cut's publish status is `uploading`, so the publish chip 2.4 adds will move on by itself.
- `api/files/ready.ts`: `fileReady(client, file, timeoutMs)`. I moved this out of `submit-take.ts` so takes and cuts share one wait. A cut gets 5 minutes and a take keeps 2, since ClamAV takes longer on a video of up to 100 MB. The error message is now `file rejected: <code>`.
- `submit-take` now also invalidates `director.shots`, so a retake shows in the editor on the way back.
- `latest.ts` keeps only `takeInProgress`. `latestTakes` had no users left: the editor now plays the pick, not the newest take.
- `packages/contracts/src/ids.ts` exports the `DirectorTakeId` type.

### apps/web: the editor (`/director/[videoId]/edit`)
- I moved the route from `/review` to `/edit` (`ReviewPage` → `EditPage`). The shoot flow's last shot now wraps into `/edit?audio=…&wrap=1`. The wrap call and auto-play are kept.
- Layout: a top bar (back, title, **Save video**), then the 9:16 preview (captions overlaid as before), then the transport (play/pause, clock, Captions, Sound, Undo, Redo), then the **shot board** (`components/shot-board.tsx`).
- The shot board:
  - **Columns (x):** one per shot, in play order, scroll-snapped per shot. A column is as wide as its shot is long (`columnWidth`: 56 px/s), kept between 156 and 320 px. That keeps a half-second shot tappable and stops a long one pushing the rest off a phone.
  - **Header:** shot number, title and length, over a bar that fills as the clock plays the shot. Tapping it plays from that shot.
  - **Stepper:** `‹ Take 2 of 3 ›` right under the header, so it stays in reach on a short phone board.
  - **Takes (y):** stacked in filmed order (Take 1 is the oldest) as a radio group; tapping one picks it. The take playing is outlined.
  - **Director's pick** (`pickedTakeId`) gets the aurora sparkle and "Director's pick".
  - **Score:** shown on each card, or a shimmer while the take is still being reviewed.
  - **Feedback:** Gemini's feedback for the take playing, in Director's marker hand.
  - **Needs a retake:** when `needsRetake` is set, a yellow note shows the picked take's feedback and a Retake button to `/director/[id]/shoot?shot=i&audio=…`.
  - **Other shots:** filmed shots get a quiet Retake link; shots not filmed yet get "Film it".
  - Each column is a `<fieldset>` (biome's a11y rule). While the video plays, the shot playing scrolls into view.
- `lib/picks.ts` decides which take each shot plays: the member's pick, else Director's pick, else the newest take. It also does the stepping and builds the `picks` record a cut saves.
- Picks live in `useEditHistory` beside caption style and sound, so Undo and Redo cover pick changes. Picking a take seeks the preview to that shot.
- `useTakeMedia` is keyed by take id. A take is downloaded the first time it's picked, then kept, so picking back is instant and a phone doesn't fetch every attempt. Each card shows one frame from the middle of the part kept.
- `EditPlayer` gives each take its own media element (`data-take` on it), so a new pick swaps the element.
- **Save video** (`useSaveVideo` in `pages/edit.tsx`):
  1. Refuses before rendering when the edit is longer than `MAX_SECONDS`.
  2. Renders with `stitch()` at 720×1280, about 4 Mbit/s video and 128 kbit/s audio. MediaRecorder writes MP4/H.264 where the browser can, WebM otherwise.
  3. Refuses before uploading when the file is over the purpose's 100 MB cap.
  4. Uploads it and saves the cut under the plan's title.
  5. Shows progress as a `GeminiLoader` over the player: "Putting your video together… 29%", then "Saving to My media…".
  6. Ends on a "Saved to My media" overlay that plays the video, with **Open My media** (`/media`) and Download.
- The refusal message reads: "This video is too long to save: videos can be up to 3 minutes. Pick shorter takes, or film shorter shots."
- `MAX_SECONDS` (in `stitch.ts`) is 100 MB × 8 / (4 Mbit/s + 128 kbit/s), about 194 s, so it follows the contract's `maxBytes`.
- Removed: the old track timeline, the clip panel, the caption text editor and Text tool, the waveform and the ruler ticks (`edit-timeline.tsx`, `clip-panel.tsx`, `TextEditor`, `soundPeaks`/`peaks`). The brief's x/y layout replaces them. Caption style and sound stay, as transport buttons.
- Every loading state in the files I touched uses `GeminiLoader` or `GeminiShimmer`.

### apps/web: My media (`/media`)
- `pages/media.tsx` and `lib/cuts.ts` group the cuts by template, the template cut most recently first.
- Each group shows the template title, its YouTube thumbnail (`i.ytimg.com/vi/<id>/hqdefault.jpg`; the CSP already allows https images) and how many videos it has.
- Each cut is a 9:16 tile. Tapping play fetches a short-lived download URL and plays the cut inline. The player carries a caption track rebuilt from the cut's plan and picks.
- Each tile shows the title, date (`useFormatter`), length and a publish chip from `DirectorCut.publish.status`: Not published, Publishing…, Public/Unlisted/Private on YouTube, or Couldn't publish. There's no Publish button; 2.4 adds it.
- With nothing saved, an empty state links to `/library`. Load errors go through `useApiErrorMessage`.
- `/media` is added to `APP_PATHS`, `IMMERSIVE_PATHS` (the dark studio chrome of the other Director pages) and the robots `disallow` list.

### Tests
- **AI stand-in** (`test/fake-ai.ts`): now answers `POST /v1/director/cuts`, `GET /v1/director/cuts` and `GET /v1/director/plans/{id}/cuts`. It scopes cuts to the caller (the JWT subject) as `save_cut` does, works out `durationMs` the same way, and `fakeDirector` accepts `cuts`.
- **Unit:**
  - web: `picks.test.ts`, `cuts.test.ts`, `track.test.ts` (column width), `stitch.test.ts` (a 3-minute Short fits), `edit.test.ts`.
  - client: shots and media polling; save-cut (upload, check, save, media refetch); rejection; the 5-minute give-up; shots waiting until enabled.
- **Component** (`test/director/editor-parts.test.tsx`):
  - Board layout: shot order, widths, takes in filmed order, the sparkle, scores, the reviewing shimmer.
  - The needs-retake note, with feedback and the Retake link.
  - Stepper limits, stepping from Director's pick and from the member's pick.
  - Tap to pick, play from a shot's title, the progress bars, scrolling into view only while playing.
  - **Picking another take changes what the preview plays for that shot and nothing else** (`data-take` order goes from [walk1, smile] to [walk2, smile]).
- **Page** (`test/director/edit.test.tsx`):
  - **Retake badge below 60**, from the real API's `needsRetake`: a best take of 59 gets the badge, 60 doesn't.
  - The full board flow: Director's pick plays over a newer take, then step, undo/redo, play from a shot, captions and sound, film what's left.
  - **Save shows up in My media.** After "Saved to My media", the cut is in `director.media` with the right picks and duration. My media then lists it under its template as "Not published", and plays it with a caption track.
  - Refusals: a too-long edit is refused before rendering; an oversized render is refused before uploading (no cut file row is created).
  - Failures: a browser that can't record; a failed upload, then a retry.
  - An MP4 save that keeps the voice.
- **My media** (`test/director/media.test.tsx`): the empty state; grouping and order; every publish chip; another member's cut not shown; a cut that can't be opened; the shimmer, then the error.

## TDD evidence
- Client tests written first: `Failed to resolve import "./media"` (1 file failed). After the hooks: 88 passed.
- `picks.test.ts` before `picks.ts`: Test Files 1 failed, no tests. After: 5 passed.
- `cuts.test.ts` before `cuts.ts`: `Cannot find module './cuts'`. After: passes.
- The page tests found three real problems:
  - **No captions on My media's player** (biome a11y). Fixed by rebuilding the VTT from the plan and picks.
  - **Patching `Blob.prototype.size` broke the whole flow.** The oversized case now uses a `stitch` spy (`vi.mock(..., { spy: true })`, as `use-take-media.test.tsx` does) that returns a real 100,000,001-byte blob.
  - **The test passed the cut's upload too early.** It passed the upload before the page had completed it, so the API answered FILE_NOT_UPLOADED. `passCut` now waits for the page's completeUpload count to go up first.

## Commands and output

```
$ bun run lint
  ✔ bun run lint:tflint
  ✔ bun run lint:renovate
  ✔ bunx turbo run lint
lint exit 0

$ bun run check-types
 Tasks:    24 successful, 24 total
types exit 0

$ bun run type-coverage apps/web          ✔ apps/web
$ bun run type-coverage packages/client   ✔ packages/client

$ bun run test
 Tasks:    16 successful, 22 total
Failed:    @repo/webhooks#test   (src/env.test.ts "listens on WEBHOOKS_PORT…" timed out at 15 s under load)
$ bun run --filter @repo/webhooks test
       Tests  24 passed (24)
(@repo/web unit 38 files / 188 tests, @repo/client 15 / 88, @repo/i18n 1 / 11: all pass)

$ bun run --cwd apps/web test:integration test/director/editor-parts.test.tsx test/director/edit.test.tsx test/director/media.test.tsx
      Tests  28 passed | 8 skipped (36)
$ bun run --cwd apps/web test:integration:files test/director/edit.test.tsx
      Tests  8 passed | 6 skipped (14)

$ bun run --filter @repo/web coverage -- test/director src/modules/director src/app && bun scripts/coverage.ts
  Test Files 61 passed, Tests 384 passed
  nothing under apps/web/src/modules/director, lib/routes.ts or app/robots.ts below 100%
  (the full web coverage run before that: 527/528 passed; the failure was
   test/settings/avatar.test.tsx "says so when storage refuses the upload", which my change doesn't touch)

$ bun run gen    no drift
```

I didn't touch `scripts/` or the hooks, so I didn't run `bun test ./scripts/ ./.claude/hooks/`.

## In a real browser (playwright-cli -s=editor, chromium, stack 9)
- **Stack:** web, api, worker and ai on stack 9 (`turbo run dev --filter …`), signed in as the seeded `demo@example.com`.
- **Takes:** four generated 9:16 WebM takes, uploaded as that user through the real files flow. The worker and ClamAV passed them.
- **Plan:** the demo workspace had no templates (concern 1). I inserted the seed "3-Ingredient No-Oven Oreo Cake" plan from `apps/ai/app/seeds/templates.json`, plus ten takes (scores, feedback, one still in review), by SQL on stack 9's database.
- **Real save:** MP4, 12,267,240 bytes for 24.3 s, about 4.04 Mbit/s. That's on target. The worker passed it and it was saved as a cut.

Screenshots (`.superpowers/sdd/2026-10-18-director-hackathon/screenshots/task-2.3.6-7/`):
- `editor-phone.png`: 390×844. The board with Director's pick, the stepper and the retake note on shot 2.
- `editor-phone-picked.png`: shot 1 stepped to take 2. The preview plays the other take, Undo is on, and the board has snapped to shot 2.
- `editor-desktop.png`: 1440×900. Player on the left, board on the right, with the review shimmer on shot 4.
- `editor-saving.png`: "Putting your video together… 29%".
- `editor-saved.png`: "Saved to My media", with Open My media and Download.
- `media-phone.png`: My media on a phone: template thumbnail and count, the cut's tile, "Not published".
- `media-desktop-playing.png`: the cut playing inline, captions burned in.

## Decisions the brief didn't make
- **One editor route:** `/review` became `/edit` rather than keeping both. The only link to `/review` was the shoot flow's wrap, which I updated.
- **Which take plays:** the member's pick, else Director's pick, else the newest take. A shot whose takes are all still in review still plays something.
- **A pick still in review** holds its shot's place as before, and Save stays off until the review sets the part kept.
- **Column widths** are proportional within 156–320 px.
- **Cut title:** the plan's title. Editing the YouTube title belongs to 2.4's publish copy.
- **My media chrome:** immersive dark studio, with its own back link to `/library`.
- **Downloads:** only takes that get picked are downloaded. Cards for the others show a camera placeholder.
- **Text tool dropped:** its caption track lived on the timeline the brief replaces. Caption style and sound stay.

## Notes for the controller
- **Nav entry for `/media`:** the editor's Saved overlay links to it, but the shell or bottom nav (another agent's) still needs a "My media" entry. `src/lib/routes.ts` (`APP_PATHS` and `IMMERSIVE_PATHS`) is a one-line merge point with the shell work.
- **2.4's Publish button** goes in `CutCard` in `apps/web/src/modules/director/pages/media.tsx`, beside `PublishChip`.

## Concerns
1. The seeded demo workspace on stack 9 had **no templates** (`ai.director_plan` was empty), so I inserted a seed plan by SQL for the screenshots. Nothing seems to copy the 6 seeds into new workspaces on this branch yet, or it runs in a service I didn't start.
2. Tests outside my change failed intermittently under load:
   - `test/director/lib/thumbnails.test.tsx` (colours read as "other" once; passes alone)
   - `test/settings/avatar.test.tsx` "says so when storage refuses the upload"
   - `@repo/webhooks` `env.test.ts` (timeout)
   - Once, sign-up answered 500 because the Turnstile check over the network failed.
3. Rendering is real time (a 3-minute Short takes 3 minutes) and needs the tab in the foreground, as `stitch.ts` already did.

## Fix round 1

Status: DONE_WITH_CONCERNS (concerns at the end of this section; none block the fixes).

The worktree guard still refuses the shared path, so this section is appended to the worktree copy of the report:
`/Users/manas.madan/Desktop/code/director-editor/.claude/worktrees/agent-af07a49b134306914/.superpowers/sdd/2026-10-18-director-hackathon/task-2.3.6-7-report.md`.

### Rebase

- I rebased onto `origin/feat/mm/director-hackathon` twice: first 2a49a25, then afddc83 (the library/shell merge and the demo account).
- Conflicts and how I resolved them:
  - `packages/client/src/api/director/shots.ts`: upstream's version is identical in substance, so I kept it and dropped my duplicate shots tests.
  - `clip-panel.tsx` and `edit-timeline.tsx`: upstream had swapped their spinners; my deletion stands.
  - `en.json`: rebuilt from upstream plus my keys. Upstream's `director.editor.loading` ("Loading this take…") is kept for the player; my page loader is `editor.loadingTakes`.
  - `fake-ai.ts`: both the library routes and my cut routes are kept.
  - **`src/lib/routes.ts`: both sides kept.** `/media` stays in `APP_PATHS` and joins upstream's new `STUDIO_PATHS` (`["/library", "/media"]`), so My media sits on the dark stage under the site header, like the library. `IMMERSIVE_PATHS` is upstream's `["/director"]`.
  - My media's own back link is gone because the shell's header now does that job. The "My media" nav entry is still for the shell agent.
- The round-0 notes above that mention `IMMERSIVE_PATHS` and the back link are superseded by this.

### Commits (range `afddc83..b00b7bb`, after the rebase)

```
b00b7bb fix(client): stop waiting for a cancelled video's check, and never save it
cb20470 fix(web): name a retake's way back &back=edit, and type keys the catalog outgrew
e6d63b5 fix(web): dim the board and transport while the video is made
bf86bb5 test(web): an e2e spec from a reviewed take to a saved video in My media
34ae245 fix(web): say why a review failed, keep the stepper's focus, and retry a failed take
6b26ba2 fix(web): hold the editor still while it renders, and stop the render on cancel or leave
836cdab fix(web): bring a retake asked for in the editor back to the editor
(round-0 commits, rebased: 9f85712 33d80b3 2b91f14 5b84dce 6dae3df)
```

### Each item: change and test

**Important 1: lock and cancel the render.**
- `lib/stitch.ts:66-71,100,118,155,206,217`
  - `stitch` takes `signal`. A cancel stops the frame loop of the video or photo playing at its next frame, so the take is paused and the recorder paused.
  - The recorder stops in `finally`.
  - `signal.throwIfAborted()` rejects with an AbortError.
  - A signal already aborted starts nothing.
- `pages/edit.tsx:113-178` (`useSaveVideo`)
  - **Cancel and leaving share one controller.** An AbortController per save; Cancel aborts it, and so does the cleanup of a `useEffect` on unmount (`:121`).
  - **Cancel during the render** (`:155-157`): the save returns quietly, with no alert and no upload.
  - **Cancel during the upload** (`:137-141`): the save returns quietly, with no cut.
  - **Saved overlay captions:** the Saved overlay now gets the clips that were rendered (`saving.clips`, `:580`), not the current ones.
- `pages/edit.tsx:216-256` (TopBar): Save becomes Cancel while busy (`common.cancel`).
- **What is held:** `pages/edit.tsx:551` and `components/shot-board.tsx:349` make the transport, its panels and the board `inert` (and dim them) while busy. The back X stays usable, because leaving cancels.
- **Upload side** (`packages/client`):
  - `files/upload.ts:42-61`: the PUT takes the signal.
  - `files/ready.ts:22-33`: the worker-check wait stops on it.
  - `director/save-cut.ts:25-28`: no `saveCut` call after a cancel.
- Tests:
  - `test/director/edit.test.tsx:381` "holds the editor still while it renders, and cancels: no upload, no cut". It checks the inert board, transport and Retake links, then Cancel, then `stitch` rejected, Save enabled again, no alert, and no cut-video file row.
  - `:411` "cancels while the video uploads: no cut is saved, even once the file is checked". The worker check is passed after the cancel and `director.media()` stays empty.
  - `:437` "stops rendering when the member leaves mid-render, and saves nothing". It unmounts mid-render; `stitch` rejects and there is no file row.
  - `test/director/lib/stitch.test.tsx:122` "stops when cancelled in the middle of a video/photo" (recorder stopped once, video paused) and `:148` "starts nothing once already cancelled".
  - `packages/client/src/api/director/director.test.tsx`:
    - "is dropped, never saved, when cancelled while the video uploads": the PUT gets the signal.
    - "stops waiting for the worker's check once cancelled".

**Important 2: Retake returns to the editor.**
- `hooks/use-studio.ts:31-49`
  - `StudioShot.retake` marks a retake asked for in the editor.
  - `shotPage(..., retake)` appends `&back=edit`. The review suggested `then=`, but biome's `noThenProperty` refuses an object with a `then` key, so I named it `back`.
  - `nextPage` returns `/director/[id]/edit?audio=…` for a retake.
- The flag is carried through:
  - The shoot route reads `back` (`app/(app)/director/[videoId]/shoot/page.tsx`).
  - `pages/shoot.tsx:638` passes it into the studio.
  - The previous-shot tool keeps it.
- The editor's board links use it: `pages/edit.tsx:573`.
- I rewrote the stale comment in `submit-take.ts:42`.
- Tests:
  - `test/director/use-studio.test.tsx:194` covers the retake going back to the editor, and `:217` covers the shot page's URL.
  - `test/director/shoot.test.tsx:596` runs the real page with `back="edit"`: keeping a photo goes to `/edit?audio=original`.
  - `src/app/routes.test.tsx` checks the route passes `back`.
  - The editor tests' Retake and Film-it hrefs now end in `&back=edit`.

**Minor 1: a failed review shows its reason.**
- `components/shot-board.tsx:103-112`: `ReviewLine` renders `errorMessage({ code: take.error ?? "DIRECTOR_REVIEW_FAILED" })`.
- Test: `editor-parts.test.tsx:219`, both a named code and the fallback.

**Minor 2: separate copy for a video that came out too big.**
- `pages/edit.tsx:163` with the new key `director.editor.tooBig`: "This video came out bigger than {megabytes} MB, too big to save. Try shorter takes." The number comes from the purpose's `maxBytes`.
- Test: `edit.test.tsx:473`. A real 100,000,001-byte render from the `stitch` spy gets that message, and no cut file row is created.

**Minor 3: stepper focus.**
- `components/shot-board.tsx:198-204`: the stepper buttons use `aria-disabled` (dimmed) instead of `disabled`, so focus stays on the pressed button.
- Test: `editor-parts.test.tsx:339`. After stepping to the last take the button reports `aria-disabled="true"`, keeps focus, and a further press changes nothing.

**Minor 4: retry a failed download.**
- `hooks/use-take-media.ts:54-77`: a failed take is remembered and dropped from `started` once it is no longer picked, so picking it again retries. It doesn't retry while it stays picked, which would loop.
- Test: `use-take-media.test.tsx:108`. It fails, does not retry on a re-render, then succeeds when picked again (3 calls).

**Minor 5: closer-to-proportional widths.**
- `lib/track.ts:4-12`: 64 px a second, between 120 and 360 px, so columns grow with their shot from about 1.9 s.
- Tests: `track.test.ts` (2 s → 128, 1.5 s → 120, 4.5 s → 288, 30 s → 360) and the board layout test (288/120/128).

**Minor 6: the Saved overlay is a dialog.**
- `pages/edit.tsx:181-213` uses `packages/ui`'s `Dialog`/`DialogContent`/`DialogTitle`/`DialogClose`: role, focus trap, Escape to close. It is full-screen and keeps the "Back to editing" close button.
- Tests:
  - `edit.test.tsx:333` waits for `dialog` "Saved to My media".
  - The MP4 test presses Escape and the dialog closes.
  - The e2e spec runs axe on it.

**Minor 7: docs.**
- `docs/director.md:75-77`: the shoot row mentions `&back=edit`, `/review` became `/edit` with a description, and `/media` is added.

**Minor 8: e2e spec.**
- `apps/web/e2e/editor.spec.ts`: a new member, a take recorded in the page and uploaded through the real files flow (the worker checks it), and the take's review written as the AI service writes it (its role, RLS). Then:
  1. The editor shows Director's pick.
  2. Save video produces the "Saved to My media" dialog.
  3. Open My media shows the template heading, "1 video" and "Not published".
- `expectAccessible` runs on the editor, the dialog and My media.
- It skips when the API reports Director off (CI's e2e job has no YouTube key), following `library.spec.ts`. To allow that skip I added the file to `biome.jsonc`'s `noSkippedTests` override and listed it in `docs/testing.md` under Skipped tests and Suppressions. That is a lint-config edit the review asked for.
- Run: `bun run --cwd apps/web test:e2e e2e/editor.spec.ts` gave `1 passed (15.4s)` against stack 9.

**Optional 9: telling versions apart.**
- `pages/media.tsx:149`: each card shows the date and time ("Oct 18, 2026, 12:00 PM").
- Test: `media.test.tsx` checks two cards of one template by their times.

**Controller: the board must not jump when a take is picked.** Checked with playwright-cli at 390×844:
- **Stepper:** I swiped the board to shot 2 and pressed its "Next take". The board stayed on shot 2 (`r1-board-before-pick.png` → `r1-board-after-pick.png`); it only snapped shot 2's left edge into place.
- **Card tap:** tapping a take card in shot 2 picked it and kept the board on shot 2 (`r1-board-after-tap.png`).
- **No fix needed.** Picking seeks to that shot, and the board scrolls only while the video plays, and then to that same shot.
- **A test-tool quirk:** clicking the card's visually hidden radio by its playwright-cli ref didn't pick. A pointer tap on the card does, and so do the component tests.

### Other changes the checks forced
- `src/lib/metadata.ts`: page titles get their own key type. After the rebase, next-intl's key type over the merged catalog made TypeScript fail with "excessively deep" (TS2589). That type also works out every message's ICU arguments, and a title takes none.
- `packages/i18n/src/index.test.ts`: the audit-event key is read with `loosely`, for the same reason.
- Upstream will hit both errors once its catalog grows, with or without my keys.

### Commands (tails)

```
$ bun run lint                                   → lint exit 0
$ bun run check-types                            → Tasks: 24 successful, 24 total
$ bun run --filter @repo/web test                → Tests 203 passed (203)
$ bun run --filter @repo/client test             → Tests 83 passed (83)
$ bun run --filter @repo/i18n test               → Tests 11 passed (11)
$ bun run --cwd apps/web test:integration test/director test/app
                                                 → Tests 262 passed | 15 skipped (277)   (before the last two commits)
$ bun run --cwd apps/web test:integration test/director   (after them)
                                                 → 2 failed | 250 passed under load: media.test.tsx
                                                   "invites…" and live-call.test.tsx "rings…" timed out
                                                   while my dev stack shared the database; alone:
                                                   Tests 21 passed | 1 skipped (22)
$ bun run --cwd apps/web test:integration:files test/director/edit.test.tsx  → Tests 11 passed | 6 skipped (17)
$ bun run --cwd apps/web test:integration:files test/director/shoot.test.tsx → Tests 4 passed | 16 skipped (20)
$ bun run --cwd apps/web test:integration:files test/director                → Tests 15 passed (earlier in the round)
$ bun run --filter @repo/web coverage -- test/director src/modules/director src/app src/lib
  && bun run --filter @repo/client coverage && bun scripts/coverage.ts
                                                 → Tests 435 passed (435); nothing under
                                                   apps/web/src/modules/director, src/lib/metadata.ts,
                                                   src/lib/routes.ts or packages/client/src/api/director
                                                   below 100%. Still listed: packages/client/src/api/files/upload.ts
                                                   lines 13, 24 (uploadRuleParams/checkUpload, used by
                                                   the avatar page, whose tests weren't in this subset;
                                                   listed the same way in round 0)
$ bun run --cwd apps/web test:e2e e2e/editor.spec.ts → 1 passed (15.4s)
$ bun run gen                                    → no drift
```

TDD evidence (the failing run first):
- use-studio: 2 failed (shoot URL, `shotPage`), then 7 passed.
- stitch: 3 failed (no abort), then 7 passed.
- client: "dropped when cancelled" failed, then passed.
- edit page: the lock and leave tests failed ("expected false to be true" for inert, stitch "fulfilled"), then passed.
- minors: track width, board layout, failed-review text, stepper focus, the retry test and the media time all failed first.

### New screenshots
`/Users/manas.madan/Desktop/code/director-editor/.claude/worktrees/agent-af07a49b134306914/.superpowers/sdd/2026-10-18-director-hackathon/screenshots/task-2.3.6-7/`:
- `r1-board-before-pick.png`: phone width, board swiped to shot 2, which needs a retake.
- `r1-board-after-pick.png`: after "Next take" on shot 2. Still on shot 2, Take 3 of 3, Next shown as unavailable.
- `r1-board-after-tap.png`: after tapping Take 1's card. Still on shot 2, Take 1 picked with its feedback.
- `r1-rendering-cancel.png`: rendering at 5%, Save replaced by Cancel, and the board and transport held still.

### Concerns
1. **Lint config.** `biome.jsonc` gained one file in the `noSkippedTests` override, for the e2e spec's Director-off skip, as `library.spec.ts` has. The review asked for this; it is still a lint-config change.
2. **Type fixes outside the editor.** The metadata and i18n test type changes fix a TS2589 that the merged catalog causes. The integration branch will need them, or the equivalent, whatever happens to my branch.
3. **Flaky tests.** Two director browser tests (`media.test.tsx` "invites…", `live-call.test.tsx` "rings…") and one Director's Cut canvas test timed out once each, while my dev stack shared stack 9's database. Each passes when run alone.
4. **Migrations.** Stack 9's database needed `bun run db:deploy` after the rebase (the demo-account migration) before sign-up worked.
