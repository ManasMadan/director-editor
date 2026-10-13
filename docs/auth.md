# Auth

Authentication is better-auth, configured in one place: `apps/api/src/auth/auth.ts`, with
its hooks in `auth-hooks.ts` and its larger plugins in `auth-plugins.ts` beside it. It
is served under `/api/auth/*` on the site's own origin (the gateway, or the web app's
rewrites locally, route it to apps/api), so session cookies are first-party. Web and
mobile use the better-auth client from `packages/client/src/auth/client.ts`; oRPC
procedures read the session through the pipeline in `apps/api/src/rpc/procedures.ts`.

Auth never sends email itself: codes, invitations and alerts are queued on
`notifications-critical`, so a slow provider can't slow down or fail a sign-in.

## Sign-in methods

| Method | Web | Mobile | Notes |
|---|---|---|---|
| Email and password | yes | yes | 8 to 128 characters. Passwords found in public breaches are refused (Have I Been Pwned, k-anonymity; `PASSWORD_BREACH_CHECK`, on in production). No session until the email is verified. |
| Emailed codes | yes | yes | 6 digits, 5 minutes, stored hashed. They verify the address after sign-up (and sign the user in), reset a forgotten password, and change the email (a code from the current and one from the new address). Signing in unverified sends a fresh code. |
| Passkeys | yes | yes | WebAuthn, relying party = the `WEB_URL` host. Mobile uses the device's own prompt (react-native-passkeys) on the same endpoints; see "Passkeys on mobile" below. |
| Google | yes | yes | On when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. Google accounts link to an existing account with the same verified email; OAuth tokens are encrypted at rest. |
| Two-factor (TOTP) | yes | yes | A second step after the password, with 10 backup codes and an option to trust the device. |

Phone numbers are not a sign-in method. A user can add one (verified by a texted code,
`apps/api/src/modules/user/phone.service.ts`) to receive security alerts by text. A
code allows five guesses, counted atomically before each comparison, and verifying is
limited per user. Whether a number is already on another account shows only when
verifying it, never when asking for a code, so the send endpoint can't be used to find
out who has which number.

better-auth's admin plugin is on (impersonation sessions last an hour); no admin UI
ships with it.

## Sessions

- Server-side and revocable: each session is in Redis (read on every request) with a
  durable copy in Postgres (the device list, audit). There is no cookie cache, so
  signing out or revoking a session rejects the same cookie on the next request.
- 7 days, extended at most once a day while in use.
- A password reset signs out every device.
- "Sudo mode": listing devices, adding a passkey and unlinking a social account need a
  session younger than `FRESH_SESSION_AGE` (2 hours, `packages/contracts/src/auth.ts`);
  after that the web app asks the user to sign in again. API procedures get the same
  rule from the `fresh` builder (`FRESH_SESSION_REQUIRED`). Password, 2FA and account
  deletion always ask for the password.
- The mobile app uses better-auth's Expo plugin: the session lives in the device's secure
  storage and travels in a header; its `boilerplate://` scheme is a trusted origin.
  Social sign-in goes through the plugin's `/expo-authorization-proxy` redirect, which
  only sends people to a provider's sign-in page (`PROVIDER_ORIGINS` in `auth-hooks.ts`; add
  a provider's origin there along with the provider). The link back to the app never
  carries the session (`apps/api/src/auth/mobile-sign-in.ts`): the app gets a hand-off id
  and secret from `POST /mobile/sign-in/start`, signs in with the id in its callback
  URL, and trades both for the session cookies at `POST /mobile/sign-in/finish`, once.
  A hand-off lasts 10 minutes, and one wrong secret burns it (`SIGN_IN_INCOMPLETE`).
- `trustedOrigins` (CSRF) are `WEB_URL`, `APP_ORIGINS` and the mobile scheme.

## Passkeys on mobile

The app signs in with a passkey and adds one through the same endpoints as the web
app's passkey client (`/passkey/generate-*-options`, then `/passkey/verify-*`), with the
platform's own prompt in place of the browser's (`apps/mobile/src/lib/passkeys.ts`,
react-native-passkeys). The relying party stays the site's host: iOS and Android show the
prompt only for the domain the build is associated with (`webcredentials:` in
`app.config.ts`, and `get_login_creds` in `assetlinks.json`), so a passkey made on the
site works in the app and the other way round. That association is optional and off
until configured: the site serves its files only with all four of `APPLE_TEAM_ID`,
`IOS_BUNDLE_ID`, `ANDROID_PACKAGE` and `ANDROID_CERT_FINGERPRINTS` set (a partial set
stops the web app), and a build claims the domain only with its platform's identifier
([web-and-mobile.md](web-and-mobile.md), "Universal links and App Links"). Without it
the app's passkey prompt fails. The challenge cookie travels like the session cookie,
through the Expo plugin.

The API checks each answer's origin (`passkeyOrigins` in `apps/api/src/auth/auth.ts`):
`WEB_URL`, `APP_ORIGINS` (the mobile app's web build) and, only when
`ANDROID_CERT_FINGERPRINTS` is set, `android:apk-key-hash:<the certificate's SHA-256 in
base64url>` for each, which is what Android's Credential Manager reports for an app. iOS reports the
site's own origin. Adding one needs a recent sign-in, as on the web: the app's settings
ask the user to sign in again.

## Organizations and roles

Every user gets a personal workspace at sign-up, so organization-scoped features work
from the first sign-in, and new sessions start in the user's first workspace. Users can
create more and invite others (invitations last 7 days; the plan's member limit counts
pending invitations). Only sign-up makes the personal workspace (slug
`personal-<user id>`, `metadata.personal`); a client creating or updating a workspace
with either is refused, so "Personal" shown in the apps and on the consent page is true.

| Role | Can |
|---|---|
| `owner` | everything, including deleting the organization |
| `admin` | manage members, settings, API keys, webhooks, billing, the audit log |
| `member` | use the workspace |

Permissions are better-auth's organization defaults plus API key management for owners
and admins (`apps/api/src/auth/org-access.ts`). In the API:

| Builder | Lets through |
|---|---|
| `base` | anyone (and refuses clients older than `MINIMUM_CLIENT_VERSION`) |
| `authed` | a valid session |
| `fresh` | a session signed in within `FRESH_SESSION_AGE` |
| `inOrg` | a member of the session's active organization, or an API key with the procedure's scope; sets `context.orgId` for row-level security |
| `orgAdmin` | `inOrg` with role owner or admin |

Membership is re-checked on every organization-scoped request (cached in Redis for five
minutes, `apps/api/src/auth/memberships.ts`), and every membership change clears the
cache, so a removed member loses access on their next request. Deleting an account
deletes the workspaces only that user belongs to; a shared workspace without another
owner blocks deletion (`ORGANIZATION_NEEDS_OWNER`).

## API keys

Workspace keys for scripts and integrations calling the REST API (`/api/v1`), created
and revoked by owners and admins on the settings page. better-auth's api-key plugin
stores them (hashed, prefixed `bp_`), but its own endpoints are off: keys are managed
through the API's procedures (`apps/api/src/modules/api-keys`), which are typed and
audited (`org.api_key_created.v1`, `org.api_key_revoked.v1`).

- The key travels in `x-api-key` and acts as the admin who created it, with their current
  role, only in its workspace. It stops working when revoked, expired or when its creator
  leaves.
- A key outlives the session that made it, so creating one needs a recent sign-in (like
  account changes: `FRESH_SESSION_REQUIRED` two hours after signing in), every key expires (at most
  365 days; `expiresInDays: null` from older clients means the longest), and the
  workspace's owners and admins get an email when one is created. Adding a webhook
  endpoint or changing its URL follows the same rules. A password reset leaves keys
  alone: legitimate integrations would break on every reset, and the creation email is
  what tells owners to revoke one they don't recognise.
- It may only call procedures whose contract names a scope it has:

  ```ts
  list: base.meta({ apiKeyScope: "todos:read" }).route({ method: "GET", path: "/todos" })...
  ```

  Scopes are in `packages/contracts/src/api/scopes.ts`: `todos:read`, `todos:write`,
  `documents:read`, `documents:write`, `audit:read`. A procedure without one is for
  signed-in people only, so a key never reaches account settings, billing or key
  management.
- Up to 50 keys per workspace, 600 requests a minute per key, expiring after 30, 90 or 365
  days.
- The per-key limit is better-auth's: it counts in the key's own row with a
  compare-and-swap, so concurrent calls can't get past it, and a refused call writes
  nothing. So a key causes at most 600 writes to `auth.api_key` a minute. The plugin's
  Redis mode would take that load off Postgres, but it counts read-modify-write (not
  atomically, as its source says), so concurrent calls could exceed the limit: raise the
  limit a lot before trading that away.

## OAuth for MCP clients

The API is an OAuth 2.1 authorization server (better-auth's `mcp` and `jwt` plugins) for
MCP clients such as Claude or an IDE, with two protected MCP servers on the site's
origin:

| Server | Resource | Tools | Scopes |
|---|---|---|---|
| apps/api | `<site>/api/mcp` | `list_todos`, `add_todo`, `set_todo_completed`, `delete_todo` | `todos:read`, `todos:write` |
| apps/ai | `<site>/ai/mcp` | `list_documents`, `search_documents` | `documents:read` |

- Clients register themselves: by URL (Client ID Metadata Documents, fetched without
  following redirects or reaching private addresses) or with RFC 7591 dynamic
  registration, limited to 5 a minute per address.
- Signed-out users sign in through the normal pages, then approve on `/oauth/consent`,
  where they also pick the workspace. Each workspace is approved separately and travels
  in the token's `org` claim.
- Access tokens are JWTs, audience-bound to one server, valid for 15 minutes and signed
  with keys published at `/api/auth/jwks` (rotated every 90 days, old keys kept 30 days).
  Refresh tokens rotate. The JWT plugin's `/token` endpoint is off, so sessions can't be
  swapped for JWTs.
- Both servers verify tokens themselves and call `auth.mcp_grant_active` on every
  request, so disconnecting an app in settings (Security, connected apps) or leaving the
  workspace takes effect immediately. Tool calls are limited to 60 a minute per app and
  user.
- Discovery: `/.well-known/oauth-authorization-server/api/auth`,
  `/.well-known/openid-configuration/api/auth` and
  `/.well-known/oauth-protected-resource/{api,ai}/mcp`.

To add a tool, see the header of `apps/api/src/mcp/mcp.server.ts` or
[python-services.md](python-services.md).

## Secrets at rest

better-auth encrypts what it stores that would let someone act as a user: OAuth tokens
from Google, two-factor secrets and backup codes, and the private keys that sign OAuth
and MCP tokens. The key is `BETTER_AUTH_SECRET`; rotating it means adding versioned
secrets (`BETTER_AUTH_SECRETS`, `apps/api/src/auth/secrets.ts`) and then running
`bun run secrets:reencrypt`, which moves every stored value, and the webhook signing
secrets under `ENCRYPTION_KEYS`, to the newest key (`apps/api/src/secrets/reencrypt.ts`).
The rotate-secrets runbook (`.claude/skills/rotate-secrets/SKILL.md`) has the steps.

## Security alerts

Every sensitive account change emails the account's address and texts its verified
phone, and is recorded in the audit log (`apps/api/src/auth/security-alerts.ts`): email
changed (to the old address), password changed or reset, two-factor enabled or disabled,
passkey added, phone added or removed (to the previous number too), and an app
connected. The alert is sent from an after-hook only when the request succeeded, and
never fails it.

## Rate limits

better-auth limits every auth endpoint to 100 requests a minute per client IP, stored in
Redis, with tighter rules on the endpoints that guess secrets:

| Endpoint | Limit |
|---|---|
| `/sign-in/email`, `/sign-up/email`, `/email-otp/*`, `/two-factor/*` | 5 a minute |
| `/forget-password/*` | 3 a minute |
| `/oauth2/register` | 5 a minute |

Emails to an address someone else typed are limited where they're sent, whichever
endpoint asked: ten codes an hour per address (past that the code is dropped; better-auth
answers the same either way, so nobody learns which addresses have accounts), and
invitations to three a day per address and thirty an hour per inviter (refused with
429). An account belongs to at most 20 workspaces, and a workspace has at most 20
invitations waiting (`ORGANIZATION_LIMIT`, `PENDING_INVITATION_LIMIT` in
`packages/contracts/src/auth-settings.ts`). The invitation's subject names neither the
workspace nor the inviter, which someone else chose; the body quotes both.

An address can be rotated, so the endpoints that guess or send secrets are also limited
per account (`apps/api/src/auth/account-limits.ts`), whatever address the attempts come
from: 10 password sign-ins, reset-password or verify-email attempts and 10 second-factor
checks per 15 minutes, and 5 codes sent. They're keyed on the normalised email, or for a
second factor on the sign-in attempt's two-factor cookie, and refuse the attempt when
Redis is down. The cost: someone can spend an account's attempts and lock it out of
these endpoints for the window; a passkey or an existing session still works.

Every API procedure that changes something declares its limit in its contract
(`meta({ rateLimit })`, `ProcedureMeta` in `packages/contracts/src/api/base.ts`), or says
why it has none, and a contract test fails on one that does neither. The procedure
builders (`apps/api/src/rpc/procedures.ts`) apply it once they know who's calling, per
user or per workspace, with `createRateLimiter` (`packages/nest-common/src/rate-limit.ts`),
shared across replicas through Redis; past it the call gets `RATE_LIMITED` with
`retryAfterSeconds`. Declared limits: assistant questions (20 a minute), sentiment checks
(60 a minute), AI documents and file uploads (30 an hour), phone codes (5 an hour per
user, refused when Redis is down) and their checks (20 an hour), Stripe checkout and
portal pages (10 a minute per workspace), and, per workspace because they make our
servers call a customer's URL, webhook test sends (10 a minute) and redeliveries (60 a
minute). Everyday changes (preferences, keys, endpoints, marking things read) share one
allowance of 120 a minute per user, which lets Redis outages through.

A few limits live outside the contract. Phone codes are limited to 3 an hour per number
in `PhoneService`, since the number is input. Todo changes are limited in `TodoService`
(600 a minute per workspace, one API key's allowance, however many keys the workspace
spreads them over), because the MCP server's tools make them too and share it. MCP tool
calls and API keys have their own per-token and per-key limits. The email unsubscribe
link has none: it needs no session, and its signed token turns off one category for one
user, so repeating it gains nothing.

Phone codes can go to any country: there's no list of allowed country codes. Texts to
some destinations cost far more than others, and SMS pumping targets exactly those, so a
product that sends texts should add an allowlist (in `PhoneService`, before the code is
sent) for the countries it serves.

The client IP comes from `X-Forwarded-For` only when the peer is in `TRUSTED_PROXIES`;
the API overwrites the header better-auth sees with that resolved address, so a client
can't forge the IP limits are keyed on. That holds because only Cloudflare can reach the
site's hosts (the gateway requires its origin-pull certificate; see
`infra/tofu/README.md`), so the rightmost address the gateway trusts is the one
Cloudflare saw.

## Captcha

With `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` set, Cloudflare Turnstile guards
sign-up, sending a verification code and requesting a password reset. Clients get the
site key from `system.info` and send the token in the `x-captcha-response` header. The
web app renders the widget in its forms (`apps/web/src/components/captcha.tsx`).

The mobile app can't run the widget, which needs a web page, so it borrows the web
app's: `useCaptcha()` (`apps/mobile/src/lib/captcha.ts`) opens `/captcha` on the site in
the system's browser sheet (`openAuthSessionAsync` from expo-web-browser), with
`?return_to=boilerplate://captcha-done`. Once the check passes, the page sends the browser
there with `?token=`, the sheet closes, and the app sends the token like the web forms
do. Closing the sheet leaves the form with a message to try again. The page sends
tokens only to the app's scheme or to its own origin, never anywhere `return_to` says
(`apps/web/src/modules/auth/hooks/use-captcha-return.ts`), so it can't be used as an
open redirect. A token is single-use and only proves a person solved a check, so the
scheme, which any app can register on Android, is enough to carry it.

On the app's web build (the mobile end-to-end suite), the sheet is a popup. The build is
served with the captcha page on its own origin (`apps/mobile/scripts/serve-web.ts`), the
page comes back to the build's `/captcha-done`, and the root layout hands that URL to the
window that opened the popup (`maybeCompleteAuthSession`). On Android the OS also opens
the app with the scheme's link; `src/app/+native-intent.ts` drops it, so it doesn't
cover the form waiting for the token.

## Changing the auth setup

After adding or removing a better-auth plugin, `bun run --filter @repo/api auth:schema`
prints the tables the current plugin set expects (to
`node_modules/.cache/auth-schema.prisma`); port the differences into
`packages/db/prisma/schema/auth.prisma` with this repo's conventions and write a
migration ([database.md](database.md)).
