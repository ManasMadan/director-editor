# Web

The web app is the API's one client, through `packages/client`, with its copy in
`packages/i18n` and its design tokens in `packages/ui/src/styles/theme.css`.

## apps/web (Next.js)

### Render-only

The web app renders UI and nothing else: no route handlers (except the health probe,
`app/healthz/route.ts`), no server actions, no database, queues or auth-server code.
`bun run lint:boundaries` enforces it (`scripts/check-web-render-only.ts` and the
`web-has-no-backend-code` rule in `.dependency-cruiser.cjs`).

The reason: auth, tenancy, validation, rate limits and error mapping live in one request
pipeline in apps/api, which the web app and the REST API both go through. A server
action would be a second, unguarded backend that only the web app could use, and one
the REST API would drift from.

It still runs as a Node server (`output: "standalone"`), to render public pages on the
server, redirect signed-out users before any HTML is sent, set a per-request CSP nonce
(`src/proxy.ts`) and serve dynamic routes like `/director/[videoId]`.

### One origin

The browser calls the API on the site's own origin: `/rpc`, `/api/auth`,
`/api/v1` and `/api/live`. When deployed, the gateway routes those paths to apps/api
before they reach Next; locally, the rewrites in `next.config.ts` forward them to
`API_URL`. Cookies stay first-party, there's no CORS, and
nothing environment-specific is built into the bundle: every variable in
`src/env.ts` is server-only.

### Layout

```
src/app/                    routes: each page.tsx only picks a module's page and its title
src/modules/<feature>/      pages/, components/, hooks/, lib/, and index.ts (its public surface)
src/components/, src/lib/   the few things every module shares (form fields, captcha, routes)
```

A module is private except its `index.ts` (the `web-modules-only-via-barrel` rule);
code two modules need moves to `packages/ui` or `packages/client`. The app uses typed
routes and the React Compiler.

### Data

Every call goes through `packages/client`:

- `ApiProvider` (mounted in `src/app/providers.tsx`) creates the oRPC client for the
  contract in `packages/contracts` and its TanStack Query utilities, sending
  `x-app-version` and `x-locale` with every request.
- Hooks live one per procedure and are imported by exact path:
  `import { useDirectorLibraryQuery } from "@repo/client/api/director/library"`. Each file
  exports one hook, which `lint:boundaries` checks.
- `@repo/client/auth` is the better-auth client (with its plugins), and
  `@repo/client/auth/<thing>` the queries on it (sessions, passkeys), which take the app's auth client and build their keys
  with `authKeys`. `@repo/client/auth/forms` holds the shared form schemas, `useLiveUpdates` the realtime stream that invalidates queries,
  and `errorMessageKey`/`fieldErrors` turn API error codes into translated messages.

A new procedure gets its hook in `packages/client/src/api/<feature>/`; the app never
calls `fetch` for API data.

### i18n

next-intl, with every message from `packages/i18n/messages/<locale>.json` (English
only today). Each server render picks the `locale` cookie, then `Accept-Language`,
then English, and the time zone from the `tz` cookie (`src/i18n/request.ts`), so HTML
arrives translated. Every catalog is type-checked against English, so a missing key
fails `check-types`. To add a language: copy `messages/en.json`, translate it, and add the
code to `locales` and `catalogs` in `packages/i18n/src/index.ts`.

### Bundle budget

`bun run --cwd apps/web budget` (after `next build`) fails when a route's first-load
JavaScript, gzipped, passes its budget, or the part every route shares grows past its
own (`scripts/bundle-budget.ts`). CI runs it after the end-to-end suite. Raise a
budget only on purpose, in the change that needs it.

Pages with forms are the heaviest: they validate with the contract's schemas, and zod's
classic API (`import * as z from "zod"`) doesn't tree-shake, so each of them ships most of
zod. Writing the contract with `zod/mini` is what would shrink them.

## packages/ui

The web component library: shadcn-style components on Tailwind v4
(`components.json`), imported by path (`@repo/ui/components/button`). `theme.css` holds
the design tokens.

Every component has stories:

```sh
bun run --cwd packages/ui storybook      # http://localhost:6006
bun run --cwd packages/ui test:stories   # each story renders, runs its play function and passes axe, light and dark
bun run --cwd packages/ui test:visual    # screenshot of every story in both themes against the baselines (Docker)
bun run --cwd packages/ui test:visual:update
```

`test:visual` builds Storybook and runs Playwright in the official Playwright image, so
screenshots are identical on every machine and in CI.

## Shared packages

| Package | What it is |
|---|---|
| `packages/contracts` | the API contract, input schemas, limits, error codes, events |
| `packages/client` | the typed API client, hooks, auth client, realtime |
| `packages/ui` | web components, design tokens, Storybook |
| `packages/i18n` | every user-facing string, for every surface |
| `packages/email` | React Email templates (server-side only) |
| `packages/testing` | test helpers (TOTP codes) |

The web app may not import `packages/db`, `nest-common`, `jobs`, `logger` or `email`, nor
server frameworks (enforced by `lint:boundaries`).
