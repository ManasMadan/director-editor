---
paths:
  - "packages/client/**"
---

# packages/client

The web app's data layer. The app never creates its own oRPC client or calls `fetch`
against the API.

- One operation per file: `src/api/<area>/<operation>.ts`, imported by exact path
  (`@repo/client/api/shorts/feed`). There is no barrel for hooks. A file exports exactly
  one hook; plain helpers, constants and types may sit beside it, and a helper two
  operations share (`shorts/reacted.ts`) gets its own file. `scripts/check-layers.ts` (in
  `lint:boundaries`) fails on a second exported hook. Tests stay one per area
  (`src/api/<area>/<area>.test.tsx`) and import each file they cover.
- Hooks wrap the generated query utils: `const { api } = useApi()` then
  `useQuery(api.<ns>.<proc>.queryOptions(...))`, `.infiniteOptions(...)` or
  `.mutationOptions(...)`. Name them `use<Thing>Query`, `use<Thing>InfiniteQuery`,
  `use<Thing>Mutation`, matching the neighbouring files in the same area.
- Query keys come from the utils (`api.shorts.feed.key()`), never hand-written arrays.
- Queries on better-auth (sessions, passkeys) are hooks in `src/auth/<thing>.ts` too.
  They take the app's auth client as their first argument (`useSessionsQuery(authClient)`),
  and their keys come from `authKeys` in
  `src/auth/query.ts`, which is also what an app invalidates after a change. better-auth
  types these answers as `any`, so each hook names its result with the model types in
  `src/auth/client.ts`.
- Optimistic updates keep the cache transform as a pure function in its own file with a
  unit test (see `src/api/shorts/reacted.ts`), then snapshot in `onMutate`, restore in
  `onError`, and invalidate in `onSettled`.
- Errors: branch on `errorCode(error)` and render `errorMessageKey(error)` through i18n
  (`src/errors.ts`). Never show `error.message`. Global cases (`UNAUTHENTICATED`,
  `CLIENT_OUTDATED`, `NO_ACTIVE_ORGANIZATION`) are handled once in `src/provider.tsx`.
- Shared form rules and auth error keys live in `src/auth/forms.ts`; do not copy
  validation into the app.
- Hooks are tested next to their file against the contract implemented in memory:
  `standIn((os) => ({ ... }))` with only the procedures the test calls, and `renderHook`,
  both from `test/stand-in.tsx`. Polling and reconnects run on fake timers, waited on
  with `until`.
- Must run in the browser and React Native: import contract types only, no Node APIs,
  nothing from `packages/db`, `nest-common` or `jobs`.
