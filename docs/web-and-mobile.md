# Web and mobile

Both apps are clients of the same API, through the same package (`packages/client`),
with the same copy (`packages/i18n`) and design tokens (`packages/ui/src/styles/theme.css`).

## apps/web (Next.js)

### Render-only

The web app renders UI and nothing else: no route handlers (except the health probe,
`app/healthz/route.ts`, and the mobile app's association files under
`app/.well-known/`, which answer from configuration alone), no server actions, no
database, queues or auth-server code.
`bun run lint:boundaries` enforces it (`scripts/check-web-render-only.ts` and the
`web-has-no-backend-code` rule in `.dependency-cruiser.cjs`).

The reason: auth, tenancy, validation, rate limits and error mapping live in one request
pipeline in apps/api, which web, mobile, API keys and MCP clients all go through. A
server action would be a second, unguarded backend that only the web app could use, and
one the mobile app and the REST API would drift from.

It still runs as a Node server (`output: "standalone"`), to render public pages on the
server, redirect signed-out users before any HTML is sent, set a per-request CSP nonce
(`src/proxy.ts`) and serve dynamic routes like `/invitations/[id]`.

### One origin

The browser calls the API on the site's own origin: `/rpc` (web and mobile),
`/api/auth` and `/api/v1`. When deployed, the gateway routes those paths to apps/api
before they reach Next; locally, the rewrites in `next.config.ts` forward them to
`API_URL` (and `/ai/mcp` to `AI_URL`). Cookies stay first-party, there's no CORS, and
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
  `import { useTodoListInfiniteQuery } from "@repo/client/api/todo/list"`. Each file
  exports one hook, which `lint:boundaries` checks.
- `@repo/client/auth` is the better-auth client (with its plugins), and
  `@repo/client/auth/<thing>` the queries on it (workspaces, the active workspace,
  invitations, sessions, passkeys), which take the app's auth client and build their keys
  with `authKeys`. `@repo/client/auth/forms` holds the shared form schemas, `useLiveUpdates` the realtime stream that invalidates queries,
  and `errorMessageKey`/`fieldErrors` turn API error codes into translated messages.

A new procedure gets its hook in `packages/client/src/api/<feature>/`; apps never call
`fetch` for API data.

### i18n

next-intl, with every message from `packages/i18n/messages/<locale>.json` (English and
Spanish today). Each server render picks the `locale` cookie, then `Accept-Language`,
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
the design tokens both apps use.

Every component has stories:

```sh
bun run --cwd packages/ui storybook      # http://localhost:6006
bun run --cwd packages/ui test:stories   # each story renders, runs its play function and passes axe, light and dark
bun run --cwd packages/ui test:visual    # screenshot of every story in both themes against the baselines (Docker)
bun run --cwd packages/ui test:visual:update
```

`test:visual` builds Storybook and runs Playwright in the official Playwright image, so
screenshots are identical on every machine and in CI.

## apps/mobile (Expo)

- **Expo Router**: screens in `src/app` (`(auth)`, `(app)`, `invitations/[id]`,
  `update-required`), typed routes.
- **Uniwind**: Tailwind classes on React Native, with the tokens from
  `@repo/ui/theme.css` (`global.css`). Its components are its own
  (`src/components/ui`, on rn-primitives); `packages/ui` is for the web.
- **Data and auth**: the same `ApiProvider` and hooks as the web app, with an absolute
  `EXPO_PUBLIC_API_URL` and the session cookie from secure storage (better-auth's Expo
  plugin). An API answer of `CLIENT_OUTDATED` (older than `MINIMUM_CLIENT_VERSION`)
  shows the update screen.
- **i18n**: use-intl with the same catalogs.
- **Push**: `expo-notifications` gets the native FCM or APNs token and registers the device
  with the API (`src/lib/push.ts`).
- **Captcha**: when the API has Turnstile on, sign-up, resending the email code and
  asking for a password reset code first open the web app's `/captcha` page in the system's browser sheet, which hands the app a
  token through its scheme (`useCaptcha()` in `src/lib/captcha.ts`; see
  [auth.md](auth.md#captcha)). A new form whose request the API guards with captcha calls
  it too.
- **Links**: `boilerplate://` links, and the site's https invitation links once the
  site serves the association files ("Universal links and App Links" below).
- **Passkeys**: sign-in with one, and adding and removing them in settings, through the
  same better-auth endpoints as the web app's passkey client, with the device's own
  prompt from react-native-passkeys (`src/lib/passkeys.ts`): AuthenticationServices on
  iOS, Credential Manager on Android, WebAuthn on the web build. A device offers the
  passkeys of the site the build is associated with (`webcredentials`, below), so they
  work only once that optional feature is on, in a build for its https site.
- Native projects (`ios/`, `android/`) come from `expo prebuild` and aren't committed.

| Command (`bun run --cwd apps/mobile …`) | What it does |
|---|---|
| `dev` | Metro and the Expo dev server |
| `ios`, `android` | build and install a development build |
| `build:web`, `serve:web` | the app rendered for the web, served on `MOBILE_WEB_PORT` (3005) with the API and the web app's captcha page on its own origin (the mobile end-to-end suite runs against it) |
| `test` | Jest (React Native Testing Library) |
| `test:e2e` | Playwright against the web build |
| `doctor` | expo-doctor |
| `lint` | expo-doctor, then `expo install --check` (every native dependency at the version the Expo SDK expects); part of `bun run lint`, so CI's lint job runs it |

### EAS builds and over-the-air updates

`apps/mobile/eas.json` has three profiles; `APP_VARIANT` gives each its own name and
bundle id, so all three install side by side:

| Profile | Distribution | Channel |
|---|---|---|
| `development` | internal, development client (iOS simulator) | `development` |
| `preview` | internal | `preview` |
| `production` | stores, build number auto-incremented | `production` |

`.github/workflows/mobile.yml` moves the app like the other services:

- once CI has passed on a merge to `master` that touched the app or the packages it uses,
  an over-the-air update goes to the `preview` channel;
- once a release tag (`v1.4.0`, docs/deploy.md) has passed its check, both platforms build
  with the `production` profile and are submitted to the App Store and Google Play; the
  check makes sure `version` in `app.config.ts` is that version;
- a manual run publishes an update to `preview` or `production` (a hotfix).

Updates reach only builds of the same app version (`runtimeVersion: appVersion`), so
native changes always ship through a store release. The workflow is skipped until the
`EAS_PROJECT_ID` repository variable is set; it also needs the `EXPO_TOKEN` secret,
`EXPO_PUBLIC_API_URL` per EAS environment and store credentials in EAS (`bunx eas-cli
credentials`). See [repository-settings.md](repository-settings.md).

### Universal links and App Links

An optional feature, off until it's configured. Besides its `boilerplate://` scheme
(sign-in callbacks, the captcha's answer), the app then opens the site's own https links: an invitation link sent by email opens the invitation
in the app when it's installed, and in the browser when it isn't. A custom scheme isn't
verified, so any other app can register the same one; an https link is, because each
platform checks a file on the site's own host before it lets the app handle the link.
Opening an invitation link only shows the invitation, whoever opened it: joining takes a
tap on Accept.

Social sign-in still comes back through the scheme, and on Android that redirect goes
through the OS, where another app claiming the scheme could catch it. So the redirect
never carries the session (better-auth's Expo plugin would put the cookie in it): the
app asks the API for a hand-off first, signs in with the hand-off's id in its callback
URL, and trades the id and a secret it kept for the session afterwards, once
(`signInWithGoogle` in `src/lib/auth-client.ts`, `apps/api/src/auth/mobile-sign-in.ts`).
A caught link holds only the id. This is the protection RFC 8252 gives native apps with
PKCE, so the callback doesn't need a verified link.

The app side is in `apps/mobile/app.config.ts`. A build whose `EXPO_PUBLIC_API_URL` is
https claims that host for each platform whose identifier it's built with, the same
variable the site reads: with `APPLE_TEAM_ID`, `ios.associatedDomains` with `applinks:`
(links) and `webcredentials:` (passkeys); with `ANDROID_CERT_FINGERPRINTS`, an Android
`intentFilters` entry with `autoVerify: true` for `https://<host>/invitations/`. Without
them it claims nothing, since the site then serves no file to verify the claim against;
neither does a development build on a LAN address, since neither platform can verify
plain http. Associated domains
are native settings, so they reach users only through a store build. Expo Router opens
an https link at its path, so `https://<host>/invitations/<id>` lands on
`invitations/[id]` like `boilerplate://invitations/<id>` does.

The site side is two route handlers in the web app, built from its environment
(`apps/web/src/lib/app-links.ts`), the only ones besides the health probe; they answer
from configuration alone, so the app stays render-only:

| Path | What it says | From |
|---|---|---|
| `/.well-known/apple-app-site-association` | the app id `<team id>.<bundle id>` for links (`/invitations/*`) and passkeys, as `application/json` | `APPLE_TEAM_ID`, `IOS_BUNDLE_ID` |
| `/.well-known/assetlinks.json` | the package and its signing certificates' SHA-256 fingerprints, for links (`handle_all_urls`) and passkeys (`get_login_creds`) | `ANDROID_PACKAGE`, `ANDROID_CERT_FINGERPRINTS` |

Like the API's optional features (`apps/api/src/features.ts`), it's on exactly when its
variables are: with none of the four set (the default everywhere) both answer 404, never
a file with made-up ids, and the site starts as usual; with all four, both are served;
with only some, the web app refuses to start and names the missing ones
(`apps/web/src/instrumentation.ts`). Each deployed environment names the build that talks
to it, in its web service's `env` (`deploy/environments/<env>/stack.yaml` has them
commented out): production the production variant, staging and previews the preview
variant. The proxy and the gateway
leave `/.well-known/` paths other than the OAuth ones to the web app.

To turn them on:

1. Find the values: your Apple Developer team id (Membership details); the fingerprints
   of the Play app signing key (Play Console, Test and release, App integrity) and of
   the EAS upload key (`bunx eas-cli credentials`, Android, Keystore). Use the bundle id
   and package your rename gave the app.
2. Set all four for each environment's web service, and `ANDROID_CERT_FINGERPRINTS`
   for its api (Android passkeys, [auth.md](auth.md#passkeys-on-mobile)). Build the app
   with `EXPO_PUBLIC_API_URL` on that environment's https site and the same
   `APPLE_TEAM_ID` and `ANDROID_CERT_FINGERPRINTS` (the EAS environment).
3. Check them: `curl -i https://<site host>/.well-known/apple-app-site-association`
   (200, `application/json`, no redirect), Google's
   [Statement List tester](https://developers.google.com/digital-asset-links/tools/generator)
   for `assetlinks.json`, and on a device, a link to `/invitations/<id>` opening the app.

The sign-in callback keeps using the scheme: the hand-off above makes catching it
worthless, and a verified link can't hand the session over by itself either.

### Native flows (Maestro)

`apps/mobile/maestro` checks what only a real build can: the session surviving a restart
(`sign-up-and-restart.yaml`), the permission prompt and push token registration
(`push.yaml`), and links opened by the OS (`invitation-link.yaml`). Run them against a
development build with the stack up; see `apps/mobile/maestro/README.md`. They don't
run in CI.

## Shared packages

| Package | What it is |
|---|---|
| `packages/contracts` | the API contract, input schemas, limits, error codes, events, plans |
| `packages/client` | the typed API client, hooks, auth client, realtime (web and mobile) |
| `packages/ui` | web components, design tokens, Storybook |
| `packages/i18n` | every user-facing string, for every surface |
| `packages/email` | React Email templates (server-side only) |
| `packages/testing` | test helpers (TOTP codes) |

The apps may not import `packages/db`, `nest-common`, `jobs`, `logger` or `email`, nor
server frameworks (enforced by `lint:boundaries`).
