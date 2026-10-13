---
paths:
  - "apps/mobile/**"
---

# apps/mobile

Expo (expo-router, React Native, Uniwind). `apps/mobile/CLAUDE.md` has the commands and
gotchas; these are the rules.

- Screens are routes in `src/app/` (`(auth)`, `(app)` behind `Stack.Protected` in the
  root `_layout.tsx`). Data only through `@repo/client` hooks, the same as web; query
  keys from the generated utils or `authKeys`, never hand-written arrays.
- UI primitives are in `src/components/ui/` (React Native Reusables, copied in): not
  `packages/ui`, which is for the web. Styling with Uniwind classes and the shared
  tokens.
- Text through `useTranslations` from `use-intl`, with keys from `packages/i18n`. They
  aren't type-checked here: check each key exists in `packages/i18n/messages/en.json`.
- `app.config.ts` is the only build-time config: identifiers (`bundleIdentifier`,
  `package`, `scheme`) are fixed after the first store release, and per-variant values
  come from `APP_VARIANT`. Runtime config is `src/lib/config.ts` (`EXPO_PUBLIC_API_URL`,
  validated with zod); there is no `src/env.ts`. `EXPO_PUBLIC_*` is compiled into the
  app and public: never a secret.
- Native changes (a config plugin, a permission, a native dependency, `app.config.ts`)
  reach users only through a store build; over-the-air updates carry JavaScript only,
  and only to builds of the same app version (`runtimeVersion: appVersion`). Say so
  when a change needs a build.
- Dependencies: `bunx expo install <pkg>` inside `apps/mobile` (the one tool that runs
  from its folder), so the version matches the SDK. React and React Native versions
  come from the Expo SDK (the dependency-update skill).
- `eas.json` has the build profiles and channels; don't add secrets there (EAS
  environments hold them).
- Tests: Jest with React Native Testing Library for everything in `src`, at 100% like
  every file: `*.test.ts(x)` next to the file, except screens, whose tests live in
  `src/screens-tests/` (a file in `src/app` is a route). Screen tests open the whole app
  with `openApp` and answer its requests with `fakeApi` (`test/`); never `jest.mock` the
  auth client, the API client or expo-router's screens. Playwright
  against the web build for screens (`bun run test:e2e --app mobile`), Maestro for what
  only a native build shows (`maestro/`, run by hand).
- A request the API guards with captcha (sign-up, emailed codes, password reset) gets
  its headers from `useCaptcha()` (`src/lib/captcha.ts`), which opens the web app's
  `/captcha` page when captcha is on; a null result means the person closed it.
- The API must keep serving old installed builds: a breaking change raises
  `MINIMUM_CLIENT_VERSION`, which sends them to `update-required`.
