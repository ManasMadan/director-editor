# apps/web

Next.js 16 (App Router, React Compiler, next-intl), port 3000. Render-only: every read
and write goes to the API through `@repo/client`. Read
`node_modules/next/dist/docs/` before using a Next.js API you are unsure of; this
version renamed middleware to `src/proxy.ts`.

## Commands (from the repo root)

- Types (runs `next typegen` first): `bun run --filter @repo/web check-types`
- Unit tests (Node): `bun run --filter @repo/web test`
- Browser tests (pages against the real API): `bun run --filter @repo/web test:integration`
  (one file: `bun run --cwd apps/web test:integration test/auth/sign-in.test.tsx`)
- E2E against a running `bun dev`: `bun run --cwd apps/web test:e2e`
  (one spec: `bun run --cwd apps/web test:e2e e2e/todos.spec.ts`)
- E2E on a fresh production build: `bun run test:e2e --app web`
- Bundle budget (after `bun run --filter @repo/web build`): `bun run --cwd apps/web budget`

## Where things are

- `src/app/`: routes only, grouped as `(app)` (signed in) and `(auth)`.
- `src/modules/<feature>/`: pages, components, hooks, lib, and an `index.ts` barrel.
- `src/lib/routes.ts`: which paths need a session (`APP_PATHS`) or none (`GUEST_PATHS`).
- `src/proxy.ts`: session-cookie redirects and the CSP nonce.
- `src/i18n/request.ts`: locale from the `locale` cookie, then Accept-Language.
- `e2e/support.ts`: `newUser`, `signUp`, `signIn`, `mailbox` (Mailpit),
  `expectAccessible`, `createWorkspace`, `inviteAndAccept`.

## Gotchas

- `next.config.ts` rewrites `/rpc`, `/api` and `/docs` to `API_URL` in development; in
  a cluster the gateway routes them. The browser always calls its own origin.
- `typedRoutes` is on: links to paths that do not exist fail `check-types`.
- The e2e `test` fixture sends a random `x-forwarded-for` per test so per-IP rate limits
  do not trip across specs; use it instead of Playwright's `test`.
