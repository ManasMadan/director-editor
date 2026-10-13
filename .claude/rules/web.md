---
paths:
  - "apps/web/**"
---

# apps/web

- Render-only. No route handlers (`app/**/route.ts`, except `app/healthz/route.ts` and
  the mobile app's association files under `app/.well-known/`), no
  `"use server"`, no `pages/api`. The root `scripts/check-web-render-only.ts` fails the
  lint.
  Anything that reads or writes data is an API procedure in `packages/contracts` +
  `apps/api`, called through a `@repo/client` hook.
- No server-side data fetching and no `fetch(` to the API. The browser calls `/rpc` and
  `/api` on its own origin (rewritten to `API_URL` in `next.config.ts` locally, routed by
  the gateway when deployed).
- Files under `src/app/` are thin: export the page from its module and a title with
  `pageTitle("<namespace>.<key>")` from `src/lib/metadata.ts`. Dynamic params use
  `PageProps<"/route/[id]">` and `await params`.
- Features live in `src/modules/<feature>/{pages,components,hooks,lib}` with an
  `index.ts` barrel. Another module imports only that barrel (dependency-cruiser
  `web-modules-only-via-barrel`).
- UI primitives come from `@repo/ui/components/*`; add a missing primitive there, with a
  story, rather than styling one inline here.
- Text: `useTranslations` (client) or `getTranslations` from `next-intl/server`. Keys
  are type-checked through `src/global.d.ts`. Locale is not in the URL (cookie, then
  Accept-Language); do not add a `[locale]` segment. API errors render as
  `t(errorMessageKey(error), errorParams(error))`, never `error.message`.
- `src/proxy.ts` only checks that a session cookie exists and sets the CSP nonce. It is
  not authorization; the API decides. New third-party origins need a CSP entry there.
- Server config is `src/env.ts`. The browser gets no env; if the client needs a value,
  serve it from the API.
- Tests (docs/testing.md, "Web"), every file at 100%:
  - server side in Node, next to the code (`src/**/*.test.ts(x)`): helpers, the proxy,
    route files, server components (`renderHtml` and `request` from
    `test/next-server.ts`);
  - pages and client components in Chromium (`test/<module>/*.test.tsx`), rendered with
    `renderPage` from `test/render.tsx` against the real API; `*.features-off.test.tsx`
    for the API with optional features off. Data comes from the API itself
    (`test/users.ts`, `fetch("/api/auth/...")`, the page's own client); Node-only setup
    is a command in `test/commands.ts`. Stub only what has no local stand-in (Next's
    router is provided by `renderPage`);
  - user flows across pages as Playwright specs in `e2e/*.spec.ts` using the helpers in
    `e2e/support.ts` (real stack, Mailpit mailbox, `expectAccessible` for axe).
    `bun run --cwd apps/web test:e2e` runs them against a running `bun dev`;
    `bun run test:e2e --app web` builds and starts a fresh stack.
- First-load JavaScript per route has a budget (`scripts/bundle-budget.ts`,
  `bun run --cwd apps/web budget` after a build; CI runs it).
  Prefer server components for static content and lazy-load heavy client code.
