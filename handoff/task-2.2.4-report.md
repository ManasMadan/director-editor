# Task 2.2.4 report: media on Cloud Storage

Note: the dispatch's report path (`/Users/manas.madan/Desktop/code/director-editor/.superpowers/sdd/2026-10-18-director-hackathon/task-2.2.4-report.md`) is outside my worktree; the edit guard refused writing there ("Edit the worktree copy of this file instead of the shared-checkout path"), so this report is at the same relative path inside the worktree instead.

## What changed and why

Production's Director media (uploads, takes, final cuts) now lives on Google Cloud
Storage instead of the in-cluster RustFS, behind the existing `Storage` seam
(`packages/nest-common/src/storage.ts`), per the add-seam skill's rules for a second
implementation.

- **`GcsStorage`** (new class in `storage.ts`): implements `Storage` with
  `@google-cloud/storage`, Application Default Credentials (no key file — the GCE VM's
  service account locally and in every cluster), and V4 signed URLs. `getSignedUrl`
  on a client with no private key (ADC from the metadata server) falls back to the IAM
  Credentials API's `signBlob`, which is why the brief's `roles/iam.serviceAccountTokenCreator`
  grant on the VM's own service account is needed.
  - `presignUpload` binds `Content-Type` through GCS's own field. It cannot bind
    `Content-Length` the way `S3Storage` does (GCS's `extensionHeaders` must be
    `x-goog-`-prefixed, and there's no equivalent of S3's `signableHeaders` for an
    arbitrary header on a plain PUT) — documented as a comment; the file-processing
    worker's own size check is the actual enforcement, same as it always was for
    anything the signature doesn't cover.
  - `head`/`read`/`write`/`move`/`delete` map onto `getMetadata`/`download`/`save`/
    `rename`/`delete`.
- **`Storage.directUri(key)`** (new interface method, on both implementations):
  returns a `gs://bucket/key` reference on `GcsStorage`, `null` on `S3Storage`. This is
  the hook a later task wires up so Director's take review passes Gemini a `gs://`
  `VideoUrl`/`ImageUrl` instead of downloading the take over HTTP and inlining it as
  `BinaryContent` (`apps/ai/app/director.py`'s `review()` and `_download()`) — I did
  **not** wire that consumption in this task; see "What I decided / didn't do" below.
- **Env**: `STORAGE_PROVIDER` (`s3` default, or `gcs`) and `GCS_BUCKET` added to
  `storageEnv` (`packages/nest-common/src/env.ts`); `createStorage(env)` picks the
  implementation. Files are "on" when the chosen provider's bucket is set.
- **Testability**: `GcsStorage` takes an optional `client: GcsClientLike`, a narrow
  interface (`GcsFile`/`GcsClientLike` in `storage.ts`) describing only the handful of
  SDK methods it calls, which the real `@google-cloud/storage` client satisfies as-is.
  Tests pass a hand-written fake implementing that same narrow interface — this is what
  let me unit-test signed URLs, metadata, read/write/move/delete and `directUri` fully
  offline, matching the brief's "unit tests with a fake `@google-cloud/storage` client"
  requirement without any network call or real GCP credentials.
- **Deploy** (`deploy/environments/production/stack.yaml`): `api` and `worker` get
  `STORAGE_PROVIDER: gcs` / `GCS_BUCKET: director-media-1053522546520` — `worker` isn't
  named in the brief's "Files" line, but it's the other caller of `createStorage`
  (checks and moves uploaded files) and without it the upload pipeline breaks the moment
  `api` starts presigning against GCS while `worker` still looks in RustFS. `ai` and
  `ai-worker` do **not** get `STORAGE_PROVIDER`/`GCS_BUCKET`: they don't call
  `createStorage` in this codebase yet (the ai side's own future bucket setting, per
  `progress.md`'s ruling, is a separate `MEDIA_BUCKET`, not `GCS_BUCKET` — a later
  task's concern). RustFS (`deploy/environments/production/data.yaml`'s
  `storage.uploads`) is left in place: nothing in the brief's checklist asked me to
  remove it, and the checklist's own wording ("RustFS uploads server stays for
  local/kind") reads as "don't touch the mechanism," not "delete it from production."
- **Network policy**: new per-service `allowMetadataServer` flag (default `false`) in
  the stack chart (`values.schema.json`, `values.yaml`, `templates/networkpolicy.yaml`),
  opening egress to `169.254.169.254/32:80` — otherwise unreachable, since it's inside
  `networkPolicy.privateRanges`. Turned on for `api`, `worker`, `ai` and `ai-worker` in
  production. I included `ai`/`ai-worker` even though they don't read the new storage
  env vars, because they already need the metadata server for their existing Vertex AI
  calls (ADC, per the brief's "Google auth uses the VM's service account" constraint)
  — the brief's own context note names exactly these three plus `api` for this network
  policy, and `worker` is the fourth by the same reasoning as above.
- **`@google-cloud/storage`**: added to the root Bun catalog (`^8.4.0`, the latest at
  the time) and referenced as `catalog:` from `packages/nest-common/package.json`, per
  the brief's explicit instruction. I note this deviates from `@aws-sdk/client-s3`'s
  precedent (pinned directly in `nest-common/package.json`, not catalogued, since
  nothing else in the repo uses it) — I followed the brief's instruction rather than
  that precedent since it was stated explicitly.
- **Docs**: `docs/files.md` (new "In production" paragraph), `docs/environment.md`
  (`STORAGE_PROVIDER`/`GCS_BUCKET` rows), `.env.example`, the README's "Scaling path"
  row, and `.claude/skills/swap-storage/SKILL.md` (now covers both providers, a new
  "Another GCS bucket" section, and the fake-client unit-test approach).

## What I decided / didn't do, and why

The brief's "Files" line for this task includes: *"ai side reads takes as `gs://` URIs
for review."* I implemented the `Storage`-seam side of this (`directUri`) but did
**not** wire `apps/api`'s `DirectorService`/`FilesService` or `apps/ai/app/director.py`
to actually consume it (constructing a `gs://` `sourceUrl` and branching `review()` on
it to skip the HTTP download). Reasons:

1. **No way to test it.** `apps/api`'s services have no unit tests in this repo's
   convention (`grep` finds zero `*.service.test.ts` files anywhere under
   `apps/api/src`); they're covered exclusively by
   `apps/api/test/*.integration.test.ts`, which starts the real API against RustFS —
   there's no local GCS emulator or fake (unlike `packages/fake-google` for Gemini/
   YouTube) to run an equivalent suite against a `gcs`-backed `Storage`. A new branch
   in `files.service.ts`/`director.service.ts` reachable only when `STORAGE_PROVIDER=gcs`
   would be permanently unreachable by any test in CI, which breaks the repo's 100%
   coverage rule for files I'd be touching — not a hypothetical, I confirmed there's no
   existing mechanism for this.
2. **The two sides don't actually need to share an env var.** The `gs://bucket/key`
   URI `directUri` returns is self-contained; a consumer doesn't need its own
   `GCS_BUCKET` to use it, it just needs to recognize the `gs://` prefix. That
   consumption (`apps/ai/app/director.py`'s `review()`) is real work — branching on the
   URI scheme, picking `VideoUrl` vs `ImageUrl`, skipping `_download()`/`MAX_TAKE_BYTES`
   — that touches `packages/contracts`, `packages/jobs`' `sourceUrl` schema (currently
   `pattern: ^https?://` in `apps/ai/app/schemas.py`, `z.url()` in
   `packages/jobs/src/queues.ts`), and needs its own tests, which is a distinct, sizeable
   change from "add the GCS storage implementation."
3. Building a GCS fake fixture (`packages/fake-google`-style) to make that path
   testable is itself a bigger undertaking than this task's two checklist items
   describe, and risked scope creep without controller sign-off.

I surfaced this as a concern rather than silently dropping it: `directUri` exists,
documented, and tested at the seam level, so the follow-up wiring is a caller change,
not a seam change — consistent with the add-seam skill's point that "callers don't
change" when adding provider capability. `knip` (`lint:unused`) doesn't flag
`directUri` as dead, since it's a documented interface method, not a top-level export.

I also did not touch `deploy/environments/production/data.yaml`'s `storage.uploads`
RustFS section, `apps/web`'s `STORAGE_ORIGIN`/CSP, or `storage:` presign/internal
fields on the stack chart's `api`/`worker` services — the existing RustFS `storage`
Secret is still wired up for those services (now carrying unused S3_* env vars
alongside the GCS ones; `createStorage` ignores them when `STORAGE_PROVIDER=gcs`),
which I noted in a comment in `production/stack.yaml`. I considered this out of scope
("Files" names only `storage.ts`, env, and the ai-side read) and the web app's CSP
already allows `storage.googleapis.com` unconditionally (for Director's pose model),
so no CSP change was actually needed for GCS signed URLs to work.

## Commits

`0a0c3f4` — `feat(nest-common): add GcsStorage for production media on Cloud Storage`
(on branch `worktree-agent-afb969da7e706c083`, pointed at
`origin/feat/mm/director-hackathon` per setup). One commit; nothing left uncommitted
(`git status` clean after).

## Checks (commands and output tails)

All run from the worktree root.

**TDD evidence.** `packages/nest-common/src/storage.test.ts`'s new `GcsStorage`
`describe` block and `env.test.ts`'s `STORAGE_PROVIDER`/`GCS_BUCKET` assertions were
written against the implementation as I built it (not strictly red-green-refactor on a
pre-existing stub, since the class didn't exist yet to fail against) — the type-checker
caught two real bugs while iterating (a return-type arity mismatch between the narrow
`GcsFile.getMetadata` and the real SDK's `[FileMetadata, TeenyResponse]`, and a missing
parameter on `S3Storage.directUri`), both fixed before any test run; the first full test
run after that was green. I did not fake a failing-test step here beyond what tsc
already caught, since `GcsStorage` was new code with no prior broken behavior to
reproduce.

```
$ bun run --filter @repo/nest-common check-types
Exited with code 0

$ bun run --filter @repo/nest-common test
 Test Files  15 passed (15)
      Tests  91 passed (91)

$ bun run --filter @repo/nest-common coverage && bun scripts/coverage.ts
 Test Files  23 passed (23)
      Tests  128 passed (128)
# scripts/coverage.ts (whole-repo merged report): packages/nest-common/src/storage.ts
# and env.ts do NOT appear in the "below 100%" list (468 other, pre-existing files do,
# none touched by this change, e.g. apps/api/src/env.ts, packages/i18n/src/locales.ts).

$ bun run lint
# one pre-existing warning (scripts/image-scan.test.ts:279, noTemplateCurlyInString,
# untouched by me) after I fixed a biome formatting issue of my own in env.test.ts;
# every lint step (biome, boundaries, unused/knip, markers, patterns, suppressions,
# prisma, actionlint, zizmor, shellcheck, hadolint, tflint, renovate, turbo lint
# including @repo/ai's ruff/deptry) passed.

$ bun run check-types
# repo-wide; one real failure found and fixed (apps/web/test/commands.ts's own
# createStorage call was missing STORAGE_PROVIDER) — 0 errors after the fix, all 24
# turbo tasks successful.

$ bun run test
# repo-wide; 22/22 turbo tasks successful, including apps/ai's pytest (71 passed, 45
# deselected integration tests) and apps/web (165 passed).

$ bun test ./scripts/ ./.claude/hooks/
 972 pass, 0 fail (3657 expect() calls), including scripts/env.test.ts,
 scripts/env-docs.test.ts and scripts/dotenv.test.ts for the new .env.example entries.

$ bun run charts:check
# every check green: stack/data chart lint and helm-unittest, all four environments
# (local/preview/production/staging) render and validate with kubeconform, every
# platform add-on, Argo CD manifests, SOPS encryption check.

$ bun scripts/misconfig.ts
# Trivy config scan: 0 misconfigurations on every rendered manifest, including
# production-stack.yaml and production-data.yaml.

$ bun run test:integration    (background; core services)
 Tasks: 15 successful, 15 total

$ bun run test:integration:files    (background; RustFS + ClamAV profile)
 Tasks: 10 successful, 10 total
# packages/nest-common/test/storage.integration.test.ts (S3Storage against real RustFS)
# is in this run and passed — it constructs S3Storage directly, unaffected by the new
# STORAGE_PROVIDER branch in createStorage.

$ bun run gen
# no drift (git status unchanged after).
```

`bun run type-coverage packages/nest-common` reports one pre-existing issue, unrelated
to this change: `packages/i18n/src/index.ts:51` has an unused type-coverage ignore
directive (99.97%, 4323/4324). I confirmed `packages/i18n/src/index.ts` is untouched by
me (`git diff --stat` shows nothing there); nest-common's own two changed files
(`storage.ts`, `env.ts`) contribute no `any`/casts — the 1 missing line is entirely in
i18n, pulled in because type-coverage walks nest-common's full dependency graph. This
would fail the same way on `origin/feat/mm/director-hackathon` before my change, since
I never touched that file.

## Things I decided that the brief didn't spell out

- `worker` gets `STORAGE_PROVIDER`/`GCS_BUCKET`/`allowMetadataServer` in production even
  though the brief's examples only named `api` (signing) and `ai`/`ai-worker` (review) —
  see "What I decided" above; without it the upload pipeline breaks.
- `ai`/`ai-worker` get `allowMetadataServer: true` but not the storage env vars, since
  they don't call `createStorage` yet — only the network policy gap (needed for their
  existing Vertex AI ADC calls too) is closed now.
- GCS's V4 signed PUT can't bind `Content-Length` the way S3's can; documented as a
  comment rather than worked around, since the worker's post-upload size check already
  covers it.
- Used a hand-rolled narrow `GcsClientLike`/`GcsFile` interface for the fake client
  (rather than `vi.mock("@google-cloud/storage")`), so the fake is explicit, typed, and
  the real SDK needs no special-casing to satisfy it.

## Status

DONE_WITH_CONCERNS

**Commit range:** `0a0c3f4` (single commit, on top of `origin/feat/mm/director-hackathon`)

**Test summary:** every unit, integration, chart and lint check passed; one pre-existing,
unrelated type-coverage gap in `packages/i18n` (not introduced by this change).

**Concerns:**
1. The ai-side consumption of `directUri`'s `gs://` references (Director's take review
   passing a `gs://` `VideoUrl`/`ImageUrl` to Gemini instead of downloading the take) is
   **not wired up** — only the seam capability exists, tested and ready for a caller.
   Wiring it needs: a `sourceUrl` schema change in both `packages/jobs` and
   `apps/ai/app/schemas.py` to accept `gs://`, a branch in `director.py`'s `review()`,
   and — for proper coverage — either a GCS fake fixture or an accepted gap in
   `docs/testing.md`'s coverage exceptions. Flagging this explicitly for the controller
   to confirm scope before a follow-up task picks it up.
2. Production's RustFS `storage.uploads` section in `data.yaml` is untouched, so
   production pods now carry both GCS and unused RustFS env vars; I judged removing
   RustFS from production out of scope (not in the brief's "Files" list), but it's worth
   a deliberate decision rather than leaving it implicit.

## Fix round 1

Commits: `cbc013f` (fix(nest-common): decide files-on in one place and bind GCS upload
size), `dc9f0ff` (fix(deploy): stop wiring the RustFS Secret into production's
services). Range `0a0c3f4..dc9f0ff`.

### Findings → change → pinning test

1. **Files-on keyed on S3_BUCKET; half-configured states not refused.**
   - `packages/nest-common/src/storage.ts:370` new `storageBucket(env)` (chosen
     provider's bucket or undefined; throws "STORAGE_PROVIDER=gcs needs GCS_BUCKET",
     "GCS_BUCKET is set but STORAGE_PROVIDER is s3 ...", and, for symmetry, "S3_BUCKET is
     set but STORAGE_PROVIDER is gcs ..."); `:389` `filesEnabled(env)`; `:403`
     `createStorage` now goes through `storageBucket`.
   - `apps/api/src/features.ts:22` `const files = filesEnabled(env)` (module load = boot).
   - `apps/worker/src/env.ts:59` `filesEnabled(env)` evaluated unconditionally at boot,
     and the production FILE_SCANNER=none refusal keys on it.
   - `apps/worker/src/files/files.processor.ts:79` message now "no bucket for
     STORAGE_PROVIDER"; `apps/api/src/modules/files/files.module.ts:17`,
     `apps/api/src/env.ts` comments; docs (`docs/files.md` intro, `docs/environment.md`
     STORAGE_PROVIDER/S3_BUCKET/GCS_BUCKET rows, `docs/troubleshooting.md`,
     `.env.example`, swap-storage skill).
   - Tests: `storage.test.ts` "turns files on exactly when the chosen provider has its
     bucket" and the 3-case `it.each` "refuses %s, instead of silently turning files off
     or ignoring it" (storageBucket, filesEnabled and createStorage all throw);
     `apps/api/src/env.test.ts` "turn files on with the chosen storage provider's bucket,
     whichever provider it is" + two new "refuse to start ... half configured" cases;
     `apps/worker/src/env.test.ts` "refuses unscanned uploads on Cloud Storage too" and
     "refuses half-configured storage at boot, in development too" (2 cases).
2. **Upload size not bound; wrong reason; read() race.**
   - `storage.ts:287` `extensionHeaders: { "content-length": String(contentLength) }` on
     the signed PUT, with the corrected reason (V4 signs any header). `GcsFile`'s write
     config gained `extensionHeaders`.
   - `storage.ts:335-336` read() takes `generation` from the metadata it size-checked and
     downloads `file(key, { generation })`; `GcsClientLike.file` takes the optional
     `{ generation }` (the real SDK's `FileOptions`).
   - File header comment (`storage.ts:9-13`) now says both implementations bind type and
     length.
   - Tests: fake-client "signs an upload for the right object key, content type and
     expiry" asserts `extensionHeaders`; "reads an object within the limit, at the
     generation whose size it checked" asserts the download's generation; "refuses to read
     an object over the limit, without downloading it" asserts no download; real-client
     test (finding 5) asserts the actual `X-Goog-SignedHeaders`.
3. **ai comment wrong.** `deploy/environments/production/stack.yaml:51-53`: says ai's
   Vertex calls use the express key and the egress is for the coming ADC use (Cloud Run
   indexer ID tokens, reading takes from GCS). Comment only; no test.
4. **Docs vs storage Secret wiring; "workload identity".**
   - Removed the wiring instead of correcting the doc: `stack.yaml:31,39,46`
     `storage: none` for web, api and worker in production (needed anyway, since the
     services now refuse S3_BUCKET next to gcs). The data chart's RustFS still runs there,
     unused (left alone, see concerns).
   - While doing this I found web's CSP would block takes playing from GCS: `connect-src`
     allows `storage.googleapis.com` (pose model), `media-src` only adds STORAGE_ORIGIN.
     So `stack.yaml:35` sets web's `STORAGE_ORIGIN: https://storage.googleapis.com`, and
     the docs/env table/skill that said "no STORAGE_ORIGIN needed for gcs" are corrected.
   - `docs/files.md` production paragraph now matches; `storage.ts:19` and the
     `GcsStorage` doc (`:251-253`) say the VM's service account via the metadata server
     (k3s on one GCE VM, no workload identity). `deploy/charts/stack/values.yaml` storage
     comment updated.
   - Tests: `deploy/charts/stack/tests/production_test.yaml` (below) asserts no
     `S3_BUCKET` from the `storage` Secret on api/worker and web's STORAGE_ORIGIN.
5. **Cast in test; real-client test.** `storage.test.ts`: `signedUrlConfigs` typed as
   `Parameters<GcsFile["getSignedUrl"]>[0][]`, cast replaced by `required(...)`. New
   suite "GcsStorage with the real @google-cloud/storage client": RSA key generated in
   the test (`generateKeyPairSync`), real `Storage` client with those credentials (signs
   locally, offline); asserts upload URL path `/director-media/files/take-1`,
   `X-Goog-SignedHeaders=content-length;content-type;host`, `X-Goog-Expires=600`, hex
   signature; download URL `X-Goog-SignedHeaders=host`, `X-Goog-Expires=120`.
6. **helm-unittest for production values.** New
   `deploy/charts/stack/tests/production_test.yaml` renders with
   `values: [../../../environments/production/stack.yaml]`: api and worker have
   `STORAGE_PROVIDER=gcs`, `GCS_BUCKET=director-media-1053522546520`, no RustFS
   `S3_BUCKET`; web has `STORAGE_ORIGIN=https://storage.googleapis.com` and not the
   Secret's; api and worker NetworkPolicies allow `169.254.169.254/32:80`; web's doesn't.
   The existing `deployment_test.yaml` GCS case now sets `storage: none` and asserts no
   S3_BUCKET (its old title endorsed the combination the services now refuse).

### TDD evidence (red runs, before the code)

```
$ bun run --filter @repo/nest-common test -- src/storage.test.ts
 × turns files on exactly when the chosen provider has its bucket
 × refuses gcs without its bucket, ...
 × refuses a GCS bucket with the s3 provider, ...
 × refuses an S3 bucket with the gcs provider, ...
 × signs an upload for the right object key, content type and expiry
 × reads an object within the limit, at the generation whose size it checked
 × signs an upload URL bound to the object, its type, its exact size and the expiry
   (expected 'content-type;host' to be 'content-length;content-type;host')
 Tests  7 failed | 14 passed (21)

$ bun run --filter @repo/api test -- src/env.test.ts
 × turn files on with the chosen storage provider's bucket, whichever provider it is
 × refuse to start Cloud Storage without its bucket half configured
 × refuse to start a Cloud Storage bucket with the S3 provider half configured
 Tests  3 failed | 8 passed (11)

$ bun run --filter @repo/worker test -- src/env.test.ts
 × refuses unscanned uploads on Cloud Storage too
 × refuses half-configured storage at boot, in development too (gcs, no bucket)
 × refuses half-configured storage at boot, in development too (s3 + GCS_BUCKET)
 Tests  3 failed | 3 passed (6)

$ helm unittest -f tests/production_test.yaml deploy/charts/stack   # against 0a0c3f4's stack.yaml
 FAIL  production
	- keeps the api and the worker on Cloud Storage, with no RustFS keys beside it
		- asserts[2] `notContains` fail  (S3_BUCKET from the storage Secret present)
```

### Commands after the fixes (output tails)

```
$ bun run --filter @repo/nest-common test -- src/storage.test.ts
 Tests  21 passed (21)
$ bun run --filter @repo/api test -- src/env.test.ts       Tests  11 passed (11)
$ bun run --filter @repo/worker test -- src/env.test.ts    Tests  6 passed (6)
$ helm unittest deploy/charts/stack
 Test Suites: 9 passed, 9 total
 Tests:       75 passed, 75 total
$ bun run lint
  ✔ ... bun run lint:renovate
  ✔ bunx turbo run lint
lint exit 0
$ bun run check-types
 Tasks:    24 successful, 24 total
$ bun run test
 Tasks:    22 successful, 22 total
$ bun test ./scripts/ ./.claude/hooks/
 972 pass
 0 fail
$ bun run charts:check
  ✔ Argo CD manifests are valid
  ✔ every committed secret is SOPS-encrypted (5 directories)
charts exit 0
$ bun run test:integration
 Failed:    @repo/web#test:integration
   (2 browser tests: test/director/canvas-layers.test.tsx "loops the take's best
    stretch...", test/director/use-scene-guide.test.tsx "looks again at once when the
    camera is pointed somewhere new"; timing assertions, nothing I touched)
 every other package's integration suite passed
$ bun run --filter @repo/web test:integration -- test/director/canvas-layers.test.tsx test/director/use-scene-guide.test.tsx
 Test Files  2 passed (2)
      Tests  15 passed (15)
$ bun run test:integration:files
 files exit 0   (Tasks: 10 total, all successful)
$ bun run --filter @repo/nest-common coverage    Tests  134 passed (134)
$ bun run --filter @repo/api coverage            Tests  273 passed (273)
$ bun run --filter @repo/worker coverage         Tests  54 passed (54)
$ bun scripts/coverage.ts
 495 source files, 3 reports: 369 below 100%.
 (none of them a file I touched: storage.ts, env.ts, features.ts, worker env.ts,
  files.processor.ts, files.module.ts don't appear; the rest are packages whose suites
  weren't in these three reports)
$ bun run gen
 gen exit 0; no drift (git status unchanged)
```

### Decided beyond the review

- `storageBucket` also refuses `S3_BUCKET` with `STORAGE_PROVIDER=gcs` (the mirror of
  "GCS_BUCKET with s3"), which is what makes production's `storage: none` load-bearing
  rather than cosmetic.
- web's `STORAGE_ORIGIN=https://storage.googleapis.com` in production (CSP `media-src`
  gap described under finding 4).

### Concerns

- The data chart's RustFS uploads server (`deploy/environments/production/data.yaml`
  `storage.uploads`, host `files.director.mmadan.in`, 25Gi volume) still runs in
  production with nothing using it. Removing it would delete its volume and change DNS,
  so I left it for a deliberate decision.
- The `web` integration run had two timing-sensitive Director browser tests fail under
  full-suite load; both passed on an isolated rerun. They test code this change doesn't
  touch.
