# CI follow-up after PR #8 (5882581)

PR: https://github.com/ManasMadan/director-editor/pull/12 (branch `fix/mm/ci-after-director`, base master)

## What was red

Master CI for 5882581 (run 39112674200) failed on three jobs. Coverage was skipped there, and it failed on the PR once the other jobs passed:

1. Type-check: `bun run type-coverage` came in at 99.99% for apps/api. `publish.service.ts` read `marked.reason` from `Promise.allSettled`, which is typed `any`.
2. Integration tests (web browser suite):
   - `edit.test.tsx` > "saves the video, silent when it was filmed to the original, and it shows in My media": `getByRole('heading', { name: 'Morning routine' })` matched 2 elements.
   - 10 unhandled errors from `publish-sheet.test.tsx`: "the publish trigger is missing".
3. Coverage (seen on the PR's first run): `apps/api/src/modules/publish/publish.service.ts` lines 114, branches on 111. Nothing ever ran the rethrow in `copy()`.

Master Security for 5882581 (run 39112674229) passed. The scheduled Uptime run (39112820265) failed at "Fail while anything is down". It checks the deployed environments, not the code, so this PR doesn't touch it.

## Root causes and fixes

### live-call "keeps Director quiet while a take records the member's voice" (PR run 39112090461)

The call log only says "waiting for locator ... Call Director". The button never appeared at all; it wasn't a blocked click.

Cause: `useSceneGuide` (apps/web/src/modules/director/hooks/use-scene-guide.ts) captures a frame, awaits the JPEG encode, then calls `mutateAsync(checkScene)`. It never checked whether the screen was still there by then. The previous test ("carries one call through the shots...") ends by hanging up, which turns Director Live's scene guide back on, so a look starts, and then the test is cleaned up. The late check goes out after the next test's `startTest` has cleared the cookies, so it comes back 401. The unmounted page's `ApiProvider` then runs `onUnauthenticated`, which calls `authClient.signOut()` and signs out the next test's freshly signed-up user. The shoot page's plan query gets 401 and the page moves to `/sign-in`, so "Call Director" never renders. It's timing-dependent, hence flaky.

Fix: the guide drops a frame that's ready after it stopped looking. That covers the screen unmounting, and also a take or a call starting mid-capture, which used to spend a check nobody would read. A new hook test, "sends nothing for a frame it was still taking when the screen went away", failed before the fix (got `[0, 1]`, expected `[1]`) and passes after.

### edit.test ambiguous heading

c973a5f made each cut's title on its My media card an `h3`, so focus can return to it. The template's `h2` has the same text. The test now asks for `level: 2`, the template heading it meant.

### publish-sheet unhandled errors

`PublishButton`'s `finalFocus` called `required(trigger.current, ...)`. When My media unmounts with the sheet open, Base UI asks for the return-focus target during unmount, after the trigger ref has been cleared, so it threw. This was a real bug when leaving the page with the sheet open. Now it returns nothing to focus, since the card is gone.

### type-coverage

`failed()` in publish.service.ts now uses `Promise.all`, and marking the cut catches its own error as `unknown`. `giveBack` never throws, so the behaviour is the same.

### thumbnails.test.tsx "takes a 9:16 thumbnail at each time asked" (flaky; appeared on the PR's second run)

It got `['other', 'blue']`, expected `['red', 'blue']`. A local run earlier today got `['other', 'other']`. "other" means the canvas came out black, so nothing was drawn. Chrome hands a seeked frame to the video's compositor on another thread, and on a busy machine `seeked` can fire before the frame reaches it, so drawImage finds no frame. `videoFrames` (apps/web/src/modules/director/lib/thumbnails.ts) now draws after `seeked`. If the canvas is still empty (alpha 0 at the centre), it waits for the video frame callback, which it asked for before seeking, and draws again.

My first attempt always waited for the callback, and it hung on CI when seeking to where the video already was: Chrome presents nothing new then. That's why the wait only happens when the canvas comes out empty. Two new tests:
- "shows the take from its very first frame" covers seeking to 0, the case that hung.
- "draws again once the frame is on screen, when the seek got there before it" makes the first draw a no-op to cover the retry.

I couldn't reproduce the original race locally. The fix rests on the reasoning above, and the PR's last two CI runs passed.

### coverage

The rule "fall back only while YouTube is down" in `copy()` is now its own function, `noCreditWhileYouTubeIsDown`, with a unit test for both branches.

## Commits

- 422f359 fix(web): send no scene check once the camera screen has stopped looking
- 5411d29 fix(web): don't throw when My media goes away with the publish sheet open
- e2df36c fix(api): log a failed publish mark without Promise.allSettled's untyped reason
- ee978c5 test(api): cover the post's credit falling back only while YouTube is down
- fdf8d22 fix(web): draw a take's thumbnail once its frame is presented, not just seeked
- 383832b fix(web): wait for the presented frame only when the thumbnail came out empty

## Local checks (stack 9, stopped afterwards with `bun run db:down`)

- `bun run lint`, `bun run check-types`, `bun run type-coverage`: all passed.
- live-call "keeps Director quiet": passed 4 runs out of 4 (once before the fix, three times after).
- use-scene-guide.test.tsx: all 9 tests passed, including the new one.
- apps/api publish unit tests: passed.
- thumbnails.test.tsx + use-take-media.test.tsx: passed (thumbnails three times).
- I didn't run edit.test and publish-sheet.test locally. They're tagged `files` and need RustFS and ClamAV, which is too heavy for the overloaded machine, so the PR's CI covers them. The PR's first CI run passed Integration tests with these fixes.

## CI state

- PR run 39113569483 (first push): everything passed except Coverage, from the publish.service.ts gap.
- PR run 39114215996 (coverage fix): Integration failed on the thumbnails flake.
- PR run 39114993061 (first thumbnail fix): Integration failed. The new seek-to-0 test hung, because the callback never fires when the frame doesn't change.
- PR run 39115662650 (383832b): all green.
- master needs branches to be up to date, so I updated the PR branch with master (1551ba1, a production release bump). PR run 39116316365 on the updated branch: all green, 41 passed and 10 skipped across every workflow.
- Auto-merge was on (`gh pr merge --squash --auto`). PR #12 merged to master as ae43b93.
- Master CI (39116790903) and Security (39116790828) for ae43b93 were still running when I wrote this.
- Not fixed, outside CI: the scheduled Uptime run (39112820265) failed because a deployed environment didn't answer.
