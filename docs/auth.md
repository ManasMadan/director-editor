# Auth

Authentication is better-auth, configured in one place: `apps/api/src/auth/auth.ts`, with
its hooks in `auth-hooks.ts` and its larger plugins in `auth-plugins.ts` beside it. It
is served under `/api/auth/*` on the site's own origin (the gateway, or the web app's
rewrites locally, route it to apps/api), so session cookies are first-party. The web app
uses the better-auth client from `packages/client/src/auth/client.ts`; oRPC
procedures read the session through the pipeline in `apps/api/src/rpc/procedures.ts`.

Auth never sends email itself: codes are queued on `notifications-critical` and alerts
go through the outbox ([notifications.md](notifications.md)), so a slow provider can't
slow down or fail a sign-in.

## Sign-in methods

| Method | Notes |
|---|---|
| Email and password | 8 to 128 characters. Passwords found in public breaches are refused (Have I Been Pwned, k-anonymity; `PASSWORD_BREACH_CHECK`, on in production). No session until the email is verified. |
| Emailed codes | 6 digits, 5 minutes, stored hashed. They verify the address after sign-up (and sign the user in), reset a forgotten password, and change the email (a code from the current and one from the new address). Signing in unverified sends a fresh code. |
| Passkeys | WebAuthn, relying party = the `WEB_URL` host, origin `WEB_URL`. |
| Google | On when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. Google accounts link to an existing account with the same verified email; OAuth tokens are encrypted at rest. |
| Two-factor (TOTP) | A second step after the password, with 10 backup codes and an option to trust the device. |

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
  after that the web app asks the user to sign in again. Password, 2FA and account
  deletion always ask for the password.
- `trustedOrigins` (CSRF) is `WEB_URL`.

## Organizations and roles

Every user gets a personal workspace at sign-up, so organization-scoped features
(Director's library, takes and cuts) work from the first sign-in, and new
sessions start in the user's first workspace. The web app shows no workspace UI: there
is no switcher, member list or invitation. A workspace holds one member
(`WORKSPACE_MEMBER_LIMIT` in `packages/contracts/src/auth-settings.ts`): better-auth's
`membershipLimit` refuses a second member, and every invitation is refused before it's
created (no invitation email exists). Only sign-up
makes the personal workspace (slug `personal-<user id>`, `metadata.personal`); a client
creating or updating a workspace with either is refused.

| Role | Can |
|---|---|
| `owner` | everything, including deleting the organization |
| `admin` | manage members and settings |
| `member` | use the workspace |

Permissions are better-auth's organization defaults (`apps/api/src/auth/org-access.ts`).
In the API:

| Builder | Lets through |
|---|---|
| `base` | anyone (and refuses clients older than `MINIMUM_CLIENT_VERSION`) |
| `authed` | a valid session |
| `inOrg` | a member of the session's active organization; sets `context.orgId` for row-level security |

Membership is re-checked on every organization-scoped request (cached in Redis for five
minutes, `apps/api/src/auth/memberships.ts`), and every membership change clears the
cache, so a removed member loses access on their next request. Deleting an account
deletes the workspaces only that user belongs to; a shared workspace without another
owner blocks deletion (`ORGANIZATION_NEEDS_OWNER`).

## Secrets at rest

better-auth encrypts what it stores that would let someone act as a user: OAuth tokens
from Google, and two-factor secrets and backup codes. The key is `BETTER_AUTH_SECRET`;
rotating it means adding versioned secrets (`BETTER_AUTH_SECRETS`,
`apps/api/src/auth/secrets.ts`) and then running `bun run secrets:reencrypt`, which
moves every stored value to the newest key (`apps/api/src/secrets/reencrypt.ts`).
The rotate-secrets runbook (`.claude/skills/rotate-secrets/SKILL.md`) has the steps.

## Security alerts

Every sensitive account change emails the account's address and is recorded in the
audit log (`apps/api/src/auth/security-alerts.ts`): email changed (to the old address),
password changed or reset, two-factor enabled or disabled, and passkey added. The alert is sent from an after-hook only when the request succeeded, and
never fails it.

## Rate limits

better-auth limits every auth endpoint to 100 requests a minute per client IP, stored in
Redis, with tighter rules on the endpoints that guess secrets:

| Endpoint | Limit |
|---|---|
| `/sign-in/email`, `/sign-up/email`, `/email-otp/*`, `/two-factor/*` | 5 a minute |
| `/forget-password/*` | 3 a minute |

Emails to an address someone else typed are limited where they're sent, whichever
endpoint asked: ten codes an hour per address (past that the code is dropped; better-auth
answers the same either way, so nobody learns which addresses have accounts). An
account belongs to at most 20 workspaces (`ORGANIZATION_LIMIT` in
`packages/contracts/src/auth-settings.ts`).

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
`retryAfterSeconds`. Declared limits, per user: file uploads (30 an hour), Director
plans (30 an hour), indexing a short (10 an hour), scene checks (30 a minute), finding
something for one of Director's marks (60 a minute) and takes
(120 an hour). Everyday changes (the profile, saving a cut) share one allowance of 120 a
minute per user, which lets Redis outages through.

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
Director's live video call (`/api/live`) has its own limit: 20 calls an hour per user,
refused when Redis is down (`apps/api/src/server.ts`).

## Changing the auth setup

After adding or removing a better-auth plugin, `bun run --filter @repo/api auth:schema`
prints the tables the current plugin set expects (to
`node_modules/.cache/auth-schema.prisma`); port the differences into
`packages/db/prisma/schema/auth.prisma` with this repo's conventions and write a
migration ([database.md](database.md)).
