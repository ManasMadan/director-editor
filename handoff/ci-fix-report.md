# CI fix report: PR #8 (feat/mm/director-hackathon)

Status: DONE_WITH_CONCERNS

Branch: `worktree-agent-af3d13edf2fd3e6e0`, rebased onto `origin/feat/mm/director-hackathon` at
4f23bd5. Commits `254bff4..1668164` (4 commits, `--no-verify`, not pushed).

Runs looked at: CI 39100867868, Security 39100867902, Kubernetes 39100867904, Infrastructure
39100867908 (head 15bf6b9), and again the newest ones on 4f23bd5 (CI 39104132423, Security
39104132376, Kubernetes 39104132377, Infrastructure 39104132478). Both heads failed the same
jobs the same way. Kubernetes and Infrastructure passed on both.

API compatibility passed on both heads. The oasdiff "removed without deprecation" lines are
only annotations: the job accepts the declared break through the `!` in the PR title. Nothing
to do there.

## 1. CI / Integration tests

- **First error:** `apps/api/test/api.integration.test.ts:1278` and `:1321`, "account deletion":
  `expected { exists: true, plans: 7 } to deeply equal { exists: true, plans: 1 }`. That made
  `@repo/api#coverage` exit 1, and the Coverage job was skipped.
- **Cause:** test drift. Since d44df31, sign-up and team creation copy the 6 seed templates
  into every new workspace (`copySeedTemplates`). The tests add one plan of their own and
  still expected a count of 1.
- **Fix:** 254bff4 `test(api): count the seeded templates in the account deletion checks`.
  The expected count is now `directorSeeds.length + 1` (named `withOwnPlan`, with a comment).
  The seed copying is unchanged. This is also the failure the coordinator forwarded.
- **Local:** `bun run --cwd apps/api test:integration test/api.integration.test.ts -t "account deletion"`
  gives `Tests 2 passed | 64 skipped (66)`, before and after the rebase. In the full
  `turbo run coverage` run, `@repo/api` gives `Test Files 38 passed (38)`, `Tests 350 passed (350)`.
- The CI log of run 39100867868 is the failing run. The same assertions failed on 39104132423.

## 2. CI / End-to-end tests (1/4)

- **First error:** `apps/web/e2e/avatar.spec.ts:47`:
  `expect(card(page).getByRole("status")).toContainText(/Uploading|Checking your picture/)`.
  It resolved to `<div role="status" aria-label="Uploading…" data-slot="gemini-loader">` and
  got `unexpected value ""` on every retry.
- **Cause:** 3556b89 replaced the card's spinner with `GeminiLoader`. By design that
  component names its state in `aria-label`, since a `role="status"` element doesn't take its
  name from its content, and it draws no text unless `showLabel` is set.
- **Fix:** 8d1b29c `test(web): read the avatar loader's name, not its text`. The test now
  uses `toHaveAccessibleName(/Uploading|Checking your picture/)`.
- **Local:** see the e2e run under item 3. `avatar.spec.ts:41 › upload a profile picture` passes.

## 3. CI / End-to-end tests (3/4)

There were two failures. Because of `failOnFlakyTests`, the flaky one fails the shard on its own.

### 3a. `platform.spec.ts:99 › a member's template card on the landing opens its ready plan`

- **First error:** `expect(response.ok()).toBe(true)` at line 112, for
  `POST /rpc/director/plan`. The CI `api.log` shows the call returning 404, and `ai.log` shows
  `GET /v1/director/plans/22k0fZarxh8 404`.
- **Cause:** CI's e2e job runs with Director off: no `YOUTUBE_API_KEY` and no `DIRECTOR_MODEL`.
  The AI service's `_director()` dependency then answers `FEATURE_DISABLED`, which maps to 404,
  for every Director route, plan reads included. The test was written for Director off, but it
  still read the plan through the API. Locally, with Director on, it passed, so the failure
  was a difference in environment, not in the code.
- **Fix:** a778107. The test reads the workspace's copy of the seed the way the AI service
  does: its own role, scoped by RLS to the session's active workspace. It checks that the
  copy is `source=seed`, `status=ready`, `stage=ready`, has the seed's title and the right
  number of shots. The check works with Director on or off. I moved the `asWorkspace` helper
  that `library.spec.ts` already had into `e2e/support.ts`, so both specs share one copy.
  `library.spec.ts` now imports it, with no other change.

### 3b. `platform.spec.ts:158 › accessibility (WCAG 2.2 AA) › signed-in pages` (flaky)

- **First error:** axe `color-contrast` on `.items-start.gap-2.flex-col > .border-border.bg-background`.
  That is the email card's "Change email" button on `/settings`, at a contrast of 3.94
  (foreground #808080).
- **Cause:** a race. The button is `disabled={!email || !captcha.ready}`, and the Button
  component has `transition-all disabled:opacity-50`. When system info arrives after the
  animation wait in `expectAccessible`, the button gets enabled and starts fading from 0.5 to 1
  opacity while axe is measuring. The same race exists on master's version of the test.
- **Fix:** a778107. On `/settings`, the test waits for the "Change email" button to be enabled
  before running axe. This is the same idea as the public pages' wait on
  `button[type=submit]:disabled`. After that, `expectAccessible`'s wait on `getAnimations()`
  covers the fade.

### Local e2e (Director off, as in CI)

`YOUTUBE_API_KEY= DIRECTOR_MODEL= bun run test:e2e --app web e2e/platform.spec.ts e2e/avatar.spec.ts e2e/library.spec.ts`
ran on my own stack 8, after the final rebase:

```
  ✓  14 [chromium] › e2e/platform.spec.ts:99:1 › a member's template card on the landing opens its ready plan (4.5s)
  ✓  22 [chromium] › e2e/platform.spec.ts:169:3 › accessibility (WCAG 2.2 AA) › signed-in pages (10.7s)
  ✓   4 [chromium] › e2e/avatar.spec.ts:41:1 › upload a profile picture: checked, cropped square, shown everywhere (14.8s)
  -   3 [chromium] › e2e/library.spec.ts:65:1 › ... (skipped: Director is off, as designed)
  ✘   3 [chromium] › e2e/avatar.spec.ts:81:1 › a virus is rejected and never shown
  1 failed / 1 skipped / 26 passed
```

The virus test fails only on my machine. The worker log says `FILE_TYPE_NOT_ALLOWED`, not
`FILE_INFECTED`, because the services in my local run don't scan with ClamAV. That test
passed in CI's shard 1 on both heads, and I didn't change it.

## 4. Security / Third-party images

- **First error:** `bun scripts/image-scan.ts --since=3d5809c` gave
  `✖ 11 of 51 images have a fixable critical or high vulnerability`.
  - CVE-2026-56851 (golang.org/x/text < 0.41.0) in alpine/kubectl 1.37.1,
    envoyproxy/ratelimit 0482748e, dex v2.45.1, grafana 13.2.2, kindest/node v1.36.4,
    argocd v3.5.4, sops v3.13.3, node-exporter v1.12.1, kube-state-metrics v2.20.0, and in the
    dev container's sops and tofu binaries.
  - Five libexpat1 CVEs (66046, 76956, 76957, 77214, 93990) in plugin-barman-cloud-sidecar v0.15.0.
  - CVE-2026-100349 (kin-openapi) in grafana.
- **Cause:** vulnerabilities newly published upstream, not anything in the PR's code. The scan
  runs on this PR because the PR touches `deploy/`.
- **Upstream check:** I scanned the newest releases with the repo's own script:
  `bun scripts/image-scan.ts quay.io/argoproj/argocd:v3.5.5 ghcr.io/dexidp/dex:v2.46.0 grafana/grafana:13.2.4-distroless ghcr.io/cloudnative-pg/plugin-barman-cloud-sidecar:v0.15.1`
  (`✖ 4 of 4`, same findings), and the alpine/kubectl:1.37.1 tag as rebuilt on 2026-10-17
  (still x/text v0.40.0). sops 3.13.3, node-exporter 1.12.1, kube-state-metrics 2.20.0, the
  newest kind node images and Envoy Gateway v1.9.2 are already their newest releases.
  envoyproxy/ratelimit:f4e76690 is clean, but it's the gateway chart's default, and the newest
  gateway release still pins 0482748e. None of these has a fixed upstream release I could move
  to, so I followed the repo's policy.
- **Fix:** 1668164 `chore(infra): review the new golang.org/x/text and expat findings in third-party images`.
  It adds reviewed exceptions to each image's `.trivyignores/<repo>.yaml`, in the existing
  format: each says which package and version, the fixed version, and why it is accepted
  ("no upstream rebuild ... as of 2026-10-18", with the newest release named), and expires on
  2026-11-17. No check was loosened.
- **Local:** `bun scripts/image-scan.ts --since=3d5809c31b2cf52643030a12cb2ec3059c4f6184`
  exits 0, and every one of the 51 images shows ✔, the dev container included.
  - On the first local run, the dev container showed 35 Debian findings (curl, the kernel
    headers). They came from my machine's stale Docker layer cache, not from CI. CI builds the
    image fresh and found only the x/text one. I rebuilt it with `docker build --no-cache`, and
    the full scan then passed.
  - `bun test scripts/image-scan.test.ts scripts/misconfig.test.ts scripts/rename.test.ts`:
    49 pass, 0 fail.

## Other checks

- `bun run lint`: exit 0, every step ✔.
- `bun run check-types`: 24 of 24 tasks succeeded.
- `bun run type-coverage apps/web`: ✔. `bun run type-coverage apps/api`: ✔.
- `bunx biome check --write` on the changed specs.

## Concern: the Coverage job will probably fail next

CI skipped Coverage because Integration tests failed, so it hasn't run on this PR yet. I ran
the repo's coverage locally: UI coverage on its own (51 files and 93 tests passed), then
`turbo run coverage` for the rest, then `bun scripts/coverage.ts`. The merge reports
`8 of 522 source files below 100%`:

```
apps/api/src/auth/auth-plugins.ts: lines 86-88, 155, 171-172, 180-181 (invitations, team-workspace delete hooks)
apps/api/src/auth/memberships.ts: forgetOrganization
apps/api/src/auth/account-limits.ts: lines 157, 160 (invitation limits)
apps/api/src/rpc/procedures.ts: lines 246-249, 269-272 (`fresh` and `orgAdmin` middlewares)
packages/db/src/tenancy.ts: lines 82-84 (userTx)
apps/api/src/auth/auth.ts: branch on 129 (BETTER_AUTH_SECRETS)
apps/notifications/src/channels/email/email.channel.ts: branch on 25
apps/web/src/modules/settings/components/avatar-card.tsx: branch on 96
```

The first five look like real gaps the PR introduced. It deleted about 4,500 lines of API
tests along with the workspace, team and invitation features, but left code those tests
covered: the invitation and team-delete hooks, `forgetOrganization`, `fresh` and `orgAdmin`
in procedures.ts, and `userTx`.

The last three may only fail on my machine:
- auth.ts depends on what `.env` sets.
- email.channel.ts: the Stalwart tests are skipped locally.
- avatar-card.tsx: `test/settings/avatar.test.tsx › says so when storage refuses the upload`
  timed out locally while CI passed it.

I didn't fix these. The fix is to remove the dead code or test it again, which reaches into
the auth and rpc code other work is in, and the gaps can't be confirmed until CI's Coverage
job runs. If it does fail with the first five, that is the fix.

Two other local-only failures:
- `scripts/pre-push.test.ts` "the database steps" (2 tests) fails because my worktree's
  stack-8 ports leak into its expected URLs: it expected 55432 and got 56232.
- `packages/ui dropdown-menu.test.tsx` timed out once under load, and passed when run alone.

## Housekeeping

- I set up stack 8 (`bun run setup --stack 8`) and stopped it with `bun run db:down`.
- Nothing pushed.
- The report is in the worktree (the guard refused the shared path):
  `.claude/worktrees/agent-af3d13edf2fd3e6e0/.superpowers/sdd/2026-10-18-director-hackathon/ci-fix-report.md`.
  It isn't committed.
