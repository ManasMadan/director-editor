---
paths:
  - "packages/ui/**"
---

# packages/ui

The web component library: shadcn-style components (`components.json`, style
`base-nova`, on Base UI) with Tailwind v4, and the design tokens both apps use.

- A component is `src/components/<name>.tsx`, imported by path
  (`@repo/ui/components/<name>`); there's no barrel. Adding one from the registry:
  `bunx shadcn@latest add <name> --cwd packages/ui`, then make it pass lint and types
  like the rest (no `any`, no suppressions). A component that brings a hook gets it in
  `src/hooks/` (components.json's `hooks` alias); add `"./hooks/*": "./src/hooks/*.ts"`
  to package.json's exports in that change, so the apps can import it (knip flags the
  export while there's no hook for it to point at). Keep a component whole, as shadcn
  ships it: knip leaves this package's unused exports alone so it can be updated with
  `--overwrite`.
- Every component has `src/components/<name>.stories.tsx`, with a `play` function for
  anything interactive. `bun run --cwd packages/ui test:stories` renders each story in
  Chromium in the light and dark themes, runs its `play`, and fails on any axe
  violation: a component without an accessible name or with poor contrast fails here.
- A part or edge case no story shows gets a plain browser test,
  `src/components/<name>.test.tsx` (`render` from `test/render.tsx`, queried with `page`
  from `vitest/browser`), in the same run. It takes no screenshot; a new story does, so
  a new story needs its baselines generated (`test:visual:update`) in the same change.
- Visual baselines: `bun run --cwd packages/ui test:visual` compares every story with
  `visual/__screenshots__` in the Playwright Docker image (so screenshots match CI).
  A deliberate visual change: `test:visual:update`, and commit the new screenshots.
- Colours, radii and spacing come from the tokens in `src/styles/theme.css` (CSS
  variables per theme). Never a literal colour in a component; add a token if one is
  missing, for both themes. Mobile reads the same file (`apps/mobile/global.css`).
- No text of its own: labels and copy are props, translated by the app. Icons from
  `lucide-react`.
- Components are presentational: no data fetching, no `@repo/client`, nothing
  server-only. React Server Components can import them (`"use client"` only where a
  component needs state or effects).
