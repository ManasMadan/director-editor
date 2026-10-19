# Polish batch review 1 (71d4f57..0ff63b4)

### Spec Compliance
- ✅ 1. Storyboard image on seed cards, lazy, alt from title/scene: shot-list.tsx:197-260 (`loading="lazy"` :235, alt `storyboardAlt`).
- ✅ 1. Tap-to-play preview, muted/loop/playsInline, mounted only when tapped, one at a time: shot-list.tsx:218-229, :397 (`previewing` index in ShotList). No autoplay storm: a `<video>` exists only for the tapped shot.
- ✅ 1. Honest labels through i18n ("Storyboard by Nano Banana", "Preview made with Veo", "Soundtrack, made with Lyria"): en.json `director.template.*`.
- ✅ 1. Lyria player with labelled play/pause: director.tsx:312.
- ✅ 1. User plan renders as before (no URLs, `FramingBox w-16`): shot-list.tsx:277-300; test "shows no media on a member's own plan".
- ✅ 1. Expired link refetches the plan once (rate-limited to one a minute) and hides the broken element: shot-list.tsx:29, director.tsx:346, :497. But see Important #1: a refetch has side effects on media that's already working.
- ✅ 1. Tests: director.test.tsx "a seeded template's media" (4 cases). i18n keys are present.
- ✅ 2. SERVICES adds tts, nanoBanana, veo, lyria and cloudRun, and home.test.tsx checks each one: sections.tsx:93. The Vertex claims match `seed_media.py` (`vertexai=True`, Nano Banana/Veo/Lyria models), and TTS matches `settings.tts_model`. ⚠️ Cloud Run: `deploy/environments/production/stack.yaml:73` still says plans are indexed in the worker until the Cloud Run indexer is deployed. The line is only true once the controller deploys it, as the brief says it will.
- ✅ 3. speech.ts `onerror`/`onabort` go through one guarded `over` (speech.ts:105-118). The browser voice is used only if the line never started, and a superseded line does nothing. Tested.
- ✅ 3. Warm-up covers only the opening shot's first 4 lines, runs once per mount, only when `speak` is true (never on a call), and swallows failures: use-live-director.ts:107-127, :168. Cost is ≤4 requests per shoot-page open. Lines are stored server-side by key (`keptObjectUrl`), so repeated opens are cache hits.
- ✅ 3. GeminiLoader `as="span"`, used in directors-cut.tsx:190, with a test.
- ✅ 3. h1 uses `line-clamp-2`: director.tsx:172.
- ✅ 3. `vi.restoreAllMocks()` is in a file-level `afterEach`.
- ✅ 3. edit.tsx:138 checks `signal.aborted` before Saved. save-cut.ts documents the leftover (the files contract has no delete). There's a files-profile test.
- ✅ 3. indexing.py:163 runs `_repaired` in the `try`'s `else`, so `drafted` is outside the retry.

### Strengths
- Keying a failure by `{url, read}` is a sound way to let an identical re-signed link be retried after a refetch. The ref-based once-a-minute limit in `useMediaLinks` is shared by every card, so N failing images cause one refetch, not N.
- I checked the indexing.py move for behaviour change. `repair_plan` only raises `ValueError`/`ValidationError`, which were already non-retryable and non-fallback (`retryable` and `_falls_back_to_the_other_model` both return False, so the old code re-raised). The only behaviour that changed is a `drafted` (evals-only) that raises a retryable type, and that is exactly the bug. The test pins it with `TestModel` run counts.
- The speech `over` handler deduplicates `error` and the `play()` rejection through `playing === audio`, so `failed()` can't run twice.
- `stepLines` is shared with `stepCue`, so the warmed text can't drift from the spoken text.
- Using a script-created `Audio` for music-only content is consistent with speech.ts. The control is a native, labelled `<button>`, and music has no words to caption.

### Issues

**Critical:** none.

**Important**

1. **Every plan refetch swaps every signed link, which stops the soundtrack (with the wrong button state), restarts a playing preview and re-downloads every storyboard.** Locations: director.tsx:264-305 (`useLoop`), shot-list.tsx:29 (`useMediaLink`), director.service.ts:259 (`objectUrl`, signed per read).
   - Why it happens: `objectUrl` signs a new link on each read, so the string differs every second. `useDirectorPlanQuery` uses the default `refetchOnWindowFocus` with `staleTime: 30_000` (provider.tsx:67), and `director.changed` invalidates all `director.*` keys. So switching tabs or apps after 30 s, or any director nudge, re-reads the plan with new URLs.
   - Effects:
     - `useLoop`'s effect re-runs on the new `url`. Its cleanup calls `listening.abort()` and then `element.pause()`, so the `pause` listener is already gone and `setPlaying(false)` never runs. The music stops, but the button still says "Pause the soundtrack", and the next tap starts it. Labels are inverted until then.
     - The playing `<video>` gets a new `src` and restarts.
     - Each visible `<img>` gets a new URL, which is a cache miss, so it downloads again (Nano Banana PNGs × up to 11 per focus on mobile data).
   - Fix:
     - Make links sticky: in `useMediaLink`, keep the URL first received and adopt a new one only after the current one failed. Store the adopted URL in state, and replace it when `failed` is set and `read` moved on. Alternatively, have the API sign with a time-bucketed expiry so re-reads return identical strings. That also restores HTTP caching.
     - Separately, call `setPlaying(false)` in `useLoop`'s cleanup.
   - Add a browser test: play the soundtrack and a preview, force a plan refetch (`queryClient.invalidateQueries` or a `director.changed` publish), then assert both still play and the soundtrack button still says "Pause".

2. **Pre-existing: the storyboard strip overflows at phone width on long seeds, and this showcase page should fix it now.** Location: shot-list.tsx:56/62 (`flex h-14 gap-1`, `li.min-w-9`).
   - With 11 shots, 11 × 36 px + 10 × 4 px = 436 px against about 328 px of content at 360 px. Shot 11 is cut off (visible in top.png). This change didn't make it worse: `Storyboard` is untouched, and the `Soundtrack` pill above it is width-bound.
   - It's a one-class fix on the hackathon's showcase page. Either `overflow-x-auto` on the `<ol>` (with `min-w-9` kept for tap size), or wrap to two rows past N shots. Add a phone-width test asserting the last strip button is inside the viewport.

**Minor**

3. The soundtrack and the hero's YouTube audio can play at the same time, and nothing pauses one for the other (director.tsx:312). Consider pausing the soundtrack when the hero is unmuted, or the reverse.
4. After an expired preview link triggers a refetch, the member has to tap play again (shot-list.tsx:224 calls `onPlaying(false)`). This is acceptable, but resuming once the fresh link arrives would feel better. Optional.
5. The soundtrack button could expose state with `aria-pressed` in place of the swapped label, matching the strip's `aria-pressed` buttons. The current label swap is still valid.
6. `useStepsAhead` freezes `lines` from the first render (`useRef(lines.slice(...))`). That's fine because the hook mounts per shot screen, but if the shoot screen ever reuses the hook across shots, it will warm only the first. The docstring could say so.

### Assessment
**Task quality:** Needs fixes

**Reasoning:** Every brief item is implemented and tested, the indexing.py move changes behaviour only in the intended case, and the speech fixes and warm-up are correctly bounded. But ordinary plan refetches (window focus after 30 s, director nudges) re-sign every link. That stops the Lyria soundtrack with an inverted play/pause label, restarts the preview and re-downloads every storyboard. Fix that before shipping the showcase page, along with the one-line strip overflow.
