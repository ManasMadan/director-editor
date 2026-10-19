# Coverage review 1 (base 71d4f57, head 2cbe2bc)

Checkout HEAD confirmed at 2cbe2bc; working tree clean apart from the untracked `.superpowers/`. Nothing was run beyond greps, `gh pr view 8` and reads of `node_modules/better-auth` (1.7.6).

### Verdict per risk

**1. Removed code really unreachable: PASS.**
- `git grep` at 2cbe2bc for `userTx|canManageWorkspace|orgAdmin|FRESH_SESSION_REQUIRED|PENDING_INVITATION_LIMIT|INVITATION_DAYS|emailLimits.invitation|invitationsPer|afterAcceptInvitation|afterCreateInvitation|EMAIL_LIMITS` across the whole repo (apps/ai, packages/client, apps/web, docs, .claude included) returns nothing. `git grep '\bfresh\.'` in apps/packages returns nothing.
- Invitations: no `sendInvitationEmail` is configured anywhere (`git grep -i invit` over apps/packages finds only the refusal hook, tests, the events catalog entry and the Prisma model). The resend branch of `/organization/invite-member` (`node_modules/better-auth/dist/plugins/organization/routes/crud-invites.mjs:135-161`) skips `beforeCreateInvitation` but only sends mail through `sendInvitationEmail`, so the removed per-inviter and per-recipient invitation limits guarded no email.
- The `afterAcceptInvitation` and `afterCreateInvitation` hooks are optional entries that better-auth calls only when they're present. Neither can fire any more: creation is refused before the write (`crud-invites.mjs:207`), and nothing can be accepted (see 3).
- `EmailChannel.send`: its only caller, `apps/notifications/src/dispatch/dispatcher.ts:40`, passes three arguments.
- `userTx`: no callers. `withUser` is now used only by `apps/api/src/modules/files/files.repository.ts`, one statement per call.
- The code limit keeps the same Redis key (`email:codesPerRecipient`, from the old `email:${name}`), 10 an hour and fail-closed (`apps/api/src/auth/account-limits.ts:123-139`).

**2. `secrets` removed from auth.ts: PASS, behaviour unchanged; one minor divergence.**
- In better-auth 1.7.6, `dist/context/create-context.mjs:70` runs `options.secrets ?? parseSecretsEnv(env.BETTER_AUTH_SECRETS)`. Line 71 sets the legacy secret from `options.secret`, which is still `env.BETTER_AUTH_SECRET`. `env` comes from `@better-auth/core/env`, a proxy over `process.env` (`env-impl.mjs:3`).
- Production: by key names only, `deploy/environments/production/secrets/api.sops.yaml` holds `BETTER_AUTH_SECRET` and no `BETTER_AUTH_SECRETS`. Both before and after the change, production takes the single-secret path, so existing OAuth tokens, 2FA secrets and sessions are unaffected.
- `reencrypt.ts:15` still builds its key from env.ts's parse. The test harness sets `process.env` before it boots the API (`apps/api/test/harness.ts:62-72`), so the rotation test exercises the env-read path.
- Divergence (Minor, see Issues): env.ts's `parseAuthSecrets` (`apps/api/src/auth/secrets.ts:21-24`) drops empty entries, but better-auth's `parseSecretsEnv` (`secret-utils.mjs`) throws on them. A value like `2:<s>,` passes env.ts and then makes `createAuth` throw at boot. That fails closed and loudly, so no data is at risk.

**3. The invitation refusal covers every membership path: PASS.**
- `/organization/invite-member`: `beforeCreateInvitation` throws on every call (`apps/api/src/auth/auth-plugins.ts:149-154`). The existing test "refuses an invitation" (`apps/api/test/api.integration.test.ts:696-709`) reaches the hook: the owner has invite permission, and the email is new with nothing pending.
- `/organization/accept-invitation`: better-auth compares the member count with `membershipLimit` (1) before accepting (`crud-invites.mjs:275-279`). Every workspace already has its creator, so a leftover pending invitation would still be refused.
- `addMember` is created with `createAuthEndpoint({...})` and no path (`crud-members.mjs:25`), so it is server-only. It also checks `membershipLimit` (`crud-members.mjs:62-66`), and nothing in the app calls it.
- `/organization/create` makes only the creator a member, as owner. It is bounded by `ORGANIZATION_LIMIT`, and personal slugs and metadata are still refused (`auth-plugins.ts:112-113`).
- The teams option isn't set, so the team endpoints are off.
- Dropping `invitationLimit` and `invitationExpiresIn` changes nothing, because no invitation is written.

**4. `FRESH_SESSION_REQUIRED` fully removed: PASS.**
- No reference remains in i18n, contracts, the client, web, AI, docs or `.claude/` (grep above). Only `en.json` exists as a locale. The generated contracts (`apps/ai/openapi.json`, `apps/ai/app/contracts/*`, `packages/jobs/generated/*`, `packages/ai-client/src/generated/*`, `en.d.json.ts`) are all regenerated in the diff.
- `FRESH_SESSION_AGE` stays: better-auth's `freshAge` still uses it, and `docs/auth.md:33-37` still describes it correctly.
- api-compat (`.github/workflows/ci.yml:545-549`) only reports when the title matches `^[a-z]+(\([a-z-]+\))?!:`. The PR #8 title, "feat(repo)!: turn the starter into Director" (`gh pr view 8`), matches. Removing an enum value from an error response is acceptable under the declared breaking change.

**5. New tests test real behaviour and are stable: PASS.**
- Team deletion (`api.integration.test.ts:739-753`): the member's role is cached first, then the owner deletes the workspace over HTTP. The test asserts that the member gets `NO_ACTIVE_ORGANIZATION` immediately, which proves `forgetOrganization` (otherwise the cached role would still let them in for 5 minutes), and that `org.deleted.v1` is recorded with the owner as actor. `LET_IN = "FEATURE_DISABLED"` is the file's existing convention (`:90`, used at `:790`, `:809`), and the harness forces optional features off, so this is stable.
- Secret rotation (`apps/api/test/secret-rotation.integration.test.ts`): it uses Redis db 4, which no other `startApi` call uses (checked every caller). Test 1 asserts the `$ba$2$` prefix and decrypts with a key map that holds only version 2, which the authenticated cipher would refuse under the wrong key. Test 2 rewrites the row under the legacy single secret, then signs in through real TOTP. better-auth 1.7.6 has no TOTP replay guard, so reusing a code within one window is fine.
- Avatar (`apps/web/test/commands.ts:315-331`): it matches the host from `S3_ENDPOINT`, which is the endpoint the commands pass to the API they start (`commands.ts:403`) and the one `storageCors` already matched. It is equivalent to the old `:59000/` match on the default stack and correct on any `--stack n`.

**6. Commit messages: PASS.** `test(api): …`, `test(web): …` and `refactor(api)!: …` follow the Conventional format, the prose reads naturally, and there's no AI mention and no co-author trailer. A nit: the scope `api` on 2cbe2bc covers contracts, db, notifications and docs too.

### Issues

**Critical:** none.

**Important:** none.

**Minor**
1. `apps/api/src/auth/auth.ts:128-130`: the rotation secrets are now parsed in two places that disagree.
   - What: env.ts validates `BETTER_AUTH_SECRETS` with `parseAuthSecrets`, which tolerates empty entries, while better-auth separately parses the raw env var with `parseSecretsEnv`, which rejects them. Before this change, env.ts's parsed array was the one better-auth used.
   - Why: it breaks the one-implementation rule, and a trailing comma passes env validation but then crashes `createAuth` at boot. The new rotation test already covers both sides of the old `env.BETTER_AUTH_SECRETS && {...}` branch, so the removal wasn't needed for coverage.
   - Fix: restore `...(env.BETTER_AUTH_SECRETS && { secrets: env.BETTER_AUTH_SECRETS })`, which the new test now covers. If you keep the removal, make `parseAuthSecrets` refuse empty entries the way better-auth does, with a unit test.
2. `docs/database.md:89-91`: "They take a branded id…" now follows a sentence about `withUser` alone. Reword it to "These helpers take…" or "Each takes…".
3. `.claude/agents/reviewer.md:34` and `.claude/agents/security-reviewer.md:27`: the edited lines are no longer wrapped like the rest of each file. Rewrap them.
4. `.claude/rules/security.md:22`: in "adds its builder here", "here" is ambiguous inside the rules file. Name `procedures.ts`.
5. `apps/api/test/secret-rotation.integration.test.ts:62`: `.not.toBe("")` is a weak oracle. Comparing the decrypted value with the TOTP secret from `totpURI` would assert the round trip exactly. This is optional.

### Assessment

**Quality:** Approved

**Reasoning:** Every removed hook, builder and helper has no remaining caller, and the invitation refusal still blocks every HTTP path to a second membership. The `secrets` removal changes nothing in production, which sets only `BETTER_AUTH_SECRET`, and the new tests check real behaviour on any stack. The remaining items are minor: a parse divergence that fails closed at boot, and doc wording.
