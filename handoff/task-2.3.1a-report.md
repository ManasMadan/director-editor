# Task 2.3.1a report: Gemini-style loader components

## Scope
First bullet only of task 2.3.1: `packages/ui/src/components/gemini-loader.tsx` with
`GeminiLoader` and `GeminiShimmer`, a Storybook story with play tests, and exports from
the package. Did not touch `apps/web` spinners/skeletons or the app shell.

## What I built
- `packages/ui/src/components/gemini-loader.tsx`:
  - `GeminiLoader({ label?, size?: "sm"|"md"|"lg", ...divProps })`: a rotating aurora
    (blue→purple→pink) glow behind a four-point sparkle (lucide's `SparkleIcon`,
    gradient-filled via an inline `<linearGradient>` referenced by a `useId()`-scoped
    url, since the icon's path has no fill of its own to override). `role="status"
    aria-live="polite"`. `label` is shown as a caption under the sparkle and is also
    set as `aria-label`; role="status" does not take its accessible name from content
    (confirmed by a failing test against real Chromium), so the name comes from
    `aria-label={label ?? "Loading"}` rather than relying on DOM text — this is the
    "prop default" pattern the brief asked for, matching how `Spinner` hardcodes
    `aria-label="Loading"`. Without a label nothing is drawn (no sr-only span needed);
    with one, the caption is visible.
  - `GeminiShimmer({ className, ...divProps })`: same shimmer band (via
    `color-mix(in oklch, var(--aurora-2) 45%, transparent)`) sweeping across a
    `bg-muted` block, in place of `Skeleton`'s flat `animate-pulse`.
  - All motion is `motion-safe:animate-[...]`, so `prefers-reduced-motion` gets the
    gradient held still instead of off; no separate media-query block needed.
- `packages/ui/src/styles/globals.css`: added `@keyframes gemini-orbit`, `gemini-pulse`,
  `gemini-sweep` (unlayered, same pattern as `apps/web`'s `live.css`).
- `packages/ui/src/components/gemini-loader.stories.tsx`: four stories (Default, a
  custom label, all three sizes, the shimmer), each with a `play` assertion; Default
  checks the hidden-label a11y name and that nothing is visibly rendered.
- Visual baselines generated and committed (`test:visual:update`, 8 new screenshots).
- No package.json change needed: `./components/*` is already a wildcard export, no
  barrel in this package.

## Design choices worth flagging
- Reused the existing `--aurora-1/2/3` tokens (already blue→purple→pink, built for
  Director Live) rather than adding new color tokens — matches "colours come from
  tokens, add one only if missing."
- Gradient-filling a lucide icon needed an inline SVG `<defs>` + `useId()`; the icon's
  fill/stroke are overridable props (verified in lucide-react's `buildLucideIconNode`,
  rest props win over its `defaultAttributes`).

## Verification
- `bun run --filter @repo/ui check-types`: pass.
- `bunx biome check .`: pass (repo-wide; one pre-existing unrelated warning in
  `scripts/image-scan.test.ts`, not from this change). `bun run lint:unused` baseline
  unchanged, no gemini-loader entries.
- `bun run --cwd packages/ui test:stories`: 51 files / 93 tests pass (light+dark, axe
  gate included). Note: this worktree's `node_modules` was empty (likely a setup gap
  from `wt switch --create`); I ran `bun install` in the worktree to get the browser
  test runner working — flagging this since it's outside this task's direct scope but
  needed for `test:stories` to run at all.
- `bun run --cwd packages/ui test:visual:update`: 80/80 pass; new baselines committed.
- Found and fixed a real a11y bug during testing: `role="status"` does not compute its
  accessible name from text content in real Chromium (spec says name-from-author only),
  so my first draft (sr-only span) had an empty accessible name. Fixed with explicit
  `aria-label`.

## Concerns for later engineers
- `apps/web`'s spinner/skeleton replacement and the app shell (bullets 2-3) are
  untouched, as scoped.
- GeminiShimmer's sweep is invisible in the static visual baselines (Playwright freezes
  animations for screenshots, landing on the off-screen starting frame) — this is
  expected for an infinite CSS animation under `animations: "disabled"`, not a bug; the
  sweep is visible live in Storybook.
- This report could only be written inside the worktree
  (`.claude/worktrees/agent-adfede3b908415a2f/.superpowers/...`), not the shared
  checkout path given in the task, because `.superpowers/` isn't tracked by git and the
  worktree sandbox refused a write outside the worktree. Caller should copy it over if
  it needs to live in the main checkout.

## Fix round 1 (review findings)

### Important: hard-coded English fallback
`DEFAULT_LABEL = "Loading"` and `aria-label={label ?? DEFAULT_LABEL}` baked an
untranslated string into the component, breaking ui.md ("No text of its own: labels and
copy are props, translated by the app") and i18n.md (no literals, including
`aria-label`). Fixed by making `label` a required prop — the caller now always supplies
its own translated string — and adding `showLabel?: boolean` (default `false`) so the
caller opts in to drawing it as a visible caption under the sparkle; `label` is still
always set as `aria-label` (still needed: `role="status"` doesn't take its accessible
name from content, as I found testing round 1). `GeminiShimmer` never had any text of
its own, so it needed no change.

Updated `gemini-loader.stories.tsx`: `meta.args = { label: "Loading" }` so every story
has one by default (Storybook's own fixture text, not a component default); `WithLabel`
and `Sizes` pass `showLabel` to show their captions.

### Minor: stale comment
The docstring above `GeminiLoader` still described the discarded sr-only-span approach
from before I found the `role="status"` accessible-name bug. Rewrote it to describe the
actual mechanism: `label` is always the accessible name via `aria-label`, and `showLabel`
is what controls the visible caption.

### Minor: Sizes play test too shallow
It asserted `data-size` only, which would stay green even if `SIZE_CLASSES[size]` were
never applied to the icon wrapper. Added `data-slot="gemini-loader-icon"` to that wrapper
span so the test can look it up directly, and the play test now also asserts
`toHaveClass(SIZE_CLASSES[size])` on it.

### Commands run
- `bun run --filter @repo/ui check-types`: pass.
- `bun run format` / `bunx biome check .`: pass (same one pre-existing, unrelated
  warning in `scripts/image-scan.test.ts` as round 1).
- `bun run lint:unused`: no gemini-loader entries.
- `bun run --cwd packages/ui test:stories` (scoped to `gemini-loader.stories.tsx`, then
  the full suite): 8/8 then 51 files / 93 tests, all pass (light + dark, axe gate
  included).
- `bun run --cwd packages/ui test:visual:update`: 80/80 pass. Only
  `components-gemini-loader--sizes-{light,dark}.png` actually changed (Sizes now shows
  a visible caption under each sparkle via `showLabel`); `default` and `with-label`
  baselines were byte-identical, left untouched.

Committed as `05be5bd fix(ui): make GeminiLoader's label a translated, caller-owned prop`
on top of `8f34fa7` from round 0, same worktree branch.
