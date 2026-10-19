# Tasks 2.1.3 + 2.1.5 report: indexing stages, failure reasons, Cloud Run indexer

Status: DONE_WITH_CONCERNS (the concerns are listed at the end; none blocks a merge)

Commit: `cae0a28 feat(ai): index shorts in stages, and on a private Cloud Run indexer`
(one commit, rebased onto `origin/feat/mm/director-hackathon` at `2afae69`).
Worktree branch: `worktree-agent-a6048cb38990e6ff8`. Stack: 5 (now stopped with `db:down`).
This report lives inside the worktree because the guard refused the shared-checkout path. It is
left uncommitted.

## What changed and why

### 2.1.3: stages and failure reasons (`app/director.py`)
- `Director.analyze` stores each stage on the plan row and publishes `director.changed` as it
  reaches it:
  - `queued`: already written when the plan is created or retried (`index`/`_claim`).
  - `watching`: set together with `status=analyzing`, before the Gemini call.
  - `writing`: set once Gemini has answered. The indexer calls a `watched` callback; the remote
    path calls it when the indexer's answer arrives.
  - `ready`: set on save.
  - `failed`: set with the error code.
  The realtime message is still the bare nudge `{type: "director.changed"}`. `packages/contracts`
  says messages are nudges and carry no data, so the client refetches and reads `stage` from the
  plan, which already exposes it.
- RF1: a Gemini refusal about the video (private, removed, age-restricted, not found, or a URL it
  can't read) now maps to `DIRECTOR_VIDEO_UNAVAILABLE`, where it used to map to
  `DIRECTOR_VIDEO_UNREADABLE`. The api's `filmable` check still refuses too-long or unavailable
  links (`DIRECTOR_TOO_LONG`) before any plan row exists. A failed plan doesn't count: the
  partial unique index and `ai.index_used` are unchanged, and `test_a_failed_index_doesn_t_count`
  pins this.
- A ready plan now saves `audio_status`/`audio_key` from the indexing result. It also records
  the `indexed` analytics event through the existing Recorder, with
  `detail={"model", "audio"}` and `user_id=plan.created_by`.

### 2.1.5: the Cloud Run indexer
- `app/indexing.py` (new) is the seam:
  - These moved here from director.py unchanged, apart from the refusal code: `index_short`,
    `retryable`, the refusal and fallback classifiers, `youtube_video` and the retry constants.
  - `IndexFailed(code, retryable, usage)` and the `Indexer` protocol.
  - `LocalIndexer` runs `index_short`, calls `watched`, then captures audio with `fetch_audio`
    into `MEDIA_BUCKET`. It returns status `none` when no bucket is set and `failed` when the
    capture fails; the plan is ready either way.
  - `RemoteIndexer` gets an ID token from the metadata server for `INDEXER_URL` and POSTs to
    `{url}/v1/index` with `Authorization: Bearer`, timeout 900 s. How it reads failures:
    - The indexer's own error body gives the code and the usage.
    - Cloud Run's own 401/403 fail the plan without a retry.
    - 5xx and 429 are retried.
    - Transport and metadata-server errors are retried.
- `app/indexer.py` (new) is FastAPI `app` with `/health/live` and `POST /v1/index`. It has its
  own lifespan and services, no DB, Redis or caller secret.
  - It checks the ID token itself with google-auth's `verify_token` against Google's certs: the
    audience must equal `INDEXER_URL`, the issuer must be accounts.google.com, and the email must
    be the verified `INDEXER_INVOKER`.
  - Failures: 401 `UNAUTHENTICATED`, 403 `FORBIDDEN`, and 502 when the certs can't be fetched.
  - Plan failures answer with the code (422) or `UPSTREAM_UNAVAILABLE` (502, retryable).
- `app/google_auth.py` (new) provides `id_token(audience)`, `access_token()` and
  `verify_invoker(...)`. It reads the metadata server through httpx, with google-auth's
  `GCE_METADATA_HOST` read at each call.
- The model factory: Vertex with no key now builds `GoogleCloudProvider(project, location,
  base_url)`, which uses ADC. The model is still addressed by its full resource name.
- Settings were split into `GeminiSettings` (shared), `Settings` (service and worker) and
  `IndexerSettings` (Cloud Run).
  - New variables: `MEDIA_BUCKET`, `INDEXER_URL` (origin only; https in production),
    `INDEXER_INVOKER`, `GOOGLE_CERTS_URL` (https in production).
  - All four are in `.env.example` and `docs/environment.md`, and `test_settings_documented`
    now covers `IndexerSettings` too.
- `create_director` picks `RemoteIndexer` when `INDEXER_URL` is set and the local indexer
  otherwise. worker.py needed no change.
- Deploy:
  - `docs/deploy.md` has a new section, "The Cloud Run indexer", with the exact commands:
    - one-time setup: APIs, the Artifact Registry repo, the `director-indexer` service account
      and its IAM;
    - per release: mirror the image, `gcloud run deploy`, and grant the VM `run.invoker`;
    - a URL check, a health check from the VM, and switching `INDEXER_URL` on, or back off to
      roll back.
  - `stack.yaml` for production: `MEDIA_BUCKET` is set on ai and ai-worker; `INDEXER_URL` stays
    a comment until deploy.
  - A helm-unittest case asserts `MEDIA_BUCKET` on both deployments.
- Docs updated: director.md, python-services.md, apps/ai/CLAUDE.md, the analytics docstrings
  (ai and the api's comment).

## Decisions the brief didn't make
1. **The interface is extended, both ends in apps/ai.** The request gains `maxTokens`, the
   worker's reservation, which the run is capped at. `IndexResult` gains `usage`. Failed remote
   runs return their usage in the error's params (`inputTokens`, `outputTokens`). Without this,
   a run on Cloud Run couldn't be settled against the budget.
2. **`audio.status` can be `none`** when there is no `MEDIA_BUCKET` (local dev). The DB and
   contract `AudioStatus` already allow it.
3. **Audio is captured after the plan, not alongside it.** A failed plan doesn't waste a
   download, and the code stays simple.
4. **Env names in the deploy command are ours**: `GOOGLE_VERTEX`, `GOOGLE_CLOUD_PROJECT`,
   `VERTEX_LOCATION`. The brief's `GOOGLE_GENAI_USE_VERTEXAI`/`GOOGLE_CLOUD_LOCATION` are
   google-genai's names, which our settings don't read. The command also adds `INDEXER_URL`,
   `INDEXER_INVOKER` and `INDEX_FALLBACK_MODEL`.
5. **`INDEXER_URL` is Cloud Run's deterministic URL**,
   `https://director-indexer-1053522546520.us-central1.run.app`, the same string on both ends,
   so the audience matches exactly.
6. **`access_token()` is implemented and tested** as asked; nothing in the app calls it yet.
7. **No deploy script.** One under scripts/ would need its own tests; the commands are in the
   docs.

## Tests (TDD)
Red first (`bun run --filter @repo/ai test`, before implementing):
```
E   ModuleNotFoundError: No module named 'app.indexing'
E   ModuleNotFoundError: No module named 'app.google_auth'
E   ImportError: cannot import name 'IndexerSettings' from 'app.settings'
!!!!!!!!!!!!!!!!!!! Interrupted: 5 errors during collection !!!!!!!!!!!!!!!!!!!!
```
RF1 red, with the old refusal code put back temporarily:
```
E       AssertionError: assert ('failed', 'f...O_UNREADABLE') == ('failed', 'f..._UNAVAILABLE')
FAILED tests/test_director.py::test_a_video_gemini_may_not_watch_fails_without_retrying[private]
FAILED ...[age-restricted]  ...[removed]  ...[unreadable url]
FAILED tests/test_director.py::test_a_failed_index_doesn_t_count
================= 5 failed, 54 deselected, 1 warning in 5.40s ==================
```
New or changed tests:
- `test_director.py`:
  - stage sequence (`watching` during the Gemini call, 3 publishes, `ready`);
  - RF1, parametrized;
  - audio into a fake GCS with a stand-in yt-dlp (`writing` during the upload);
  - audio failure still leaves a ready plan;
  - the `indexed` event;
  - remote path: Bearer ID token with aud=INDEXER_URL and the VM email, the body, the saved plan,
    usage settled;
  - remote refusals (no retry), remote outages (retried, then failed), unreachable indexer or
    metadata server (retried).
- `test_indexer.py`:
  - health, the allowed account, auth refusals, strict request, error params, 502 for an outage;
  - `python -m uvicorn app.indexer:app` on Vertex with ADC from a fake metadata server, no key,
    through the real `RemoteIndexer`. Gemini got the Vertex path with the metadata access token.
- `test_google_auth.py`: tokens, metadata errors, every verification case, certs down.
- `test_units.py`: the ADC factory, IndexerSettings validation, production https, origin-only
  URL.
- `fakes.py`: `serve_identity` (metadata server and certs), a GCS upload stand-in, and recorded
  Authorization headers.

## Checks (tails)
- `bun run --filter @repo/ai coverage` (stack 5, after rebase): `TOTAL 1603 0 208 0 100%`,
  `Required test coverage of 100.0% reached`, `193 passed`. `bun scripts/coverage.ts` flags
  nothing under apps/ai.
- `bun run test`: `Tasks: 22 successful, 22 total`.
- `bun run lint`: all ✔, EXIT 0 (ruff, format, deptry `Success! No dependency issues found.`).
- `bun run check-types`: `24 successful, 24 total`; basedpyright `0 errors, 0 warnings, 0 notes`.
- `bun run charts:check`: all ✔, EXIT 0. `helm unittest -f tests/production_test.yaml`:
  `Tests: 8 passed`.
- `bun run gen`: no drift.
- `bun test ./scripts/`: 792 pass, 2 fail. Both are in `pre-push.test.ts`: it expects port 55432
  and gets 55932, from this worktree's stack-5 `.env.stack`. That's the environment; I didn't
  touch scripts/.
- Flakiness under a load average of about 24: `test_service.py`'s worker subprocess once exited
  -15, and the indexer subprocess once didn't start. I hardened the indexer test's readiness
  loop. Both passed on rerun.

## Concerns
1. `DIRECTOR_VIDEO_UNREADABLE` has no producer any more. It's still in contracts, i18n and web
   tests, which other workstreams own.
2. The realtime message has no `stage` (a nudge, per the contracts). The web should read
   `plan.stage` after the refetch.
3. Usage of a failed remote run travels in the error's `params`.
4. The controller needs to deploy per docs/deploy.md, then set `INDEXER_URL` in production's
   stack.yaml and promote. yt-dlp on Cloud Run may be throttled by YouTube; that only affects
   audio.

## Fix round 1 (review 1)

Commit: `905e604 fix(ai): never leave a plan analyzing, and bound the audio capture`, on top
of `cae0a28`, so the whole task is `2afae69..905e604`. Stack 5 was started again with
`bun run db:up`. Paths are relative to `apps/ai/` unless they say otherwise.

| Item | Change (file:line) | Pinned by |
|---|---|---|
| I1 a malformed answer escaping | `app/indexing.py:283` turns a 200 body that isn't an `IndexResult` into `IndexFailed(DIRECTOR_ANALYSIS_FAILED, retryable=False)` counting the whole reservation. `app/indexing.py:335` (`_usage_in`): error params that don't parse as usage also count the whole reservation. | `test_director.py::test_a_refusal_from_the_indexer_fails_the_plan_without_a_retry[result unreadable]` (the indexer answers 200 `{}`, the plan ends `failed`) and `[usage unreadable]` |
| I1 any other exception | `app/director.py:556`: in `analyze`, any other exception is logged, fails the plan when `final`, and is re-raised for BullMQ. `app/director.py:574` (`_index_and_settle`): a run that ends without saying what it used settles its whole reservation (`:580`). | `test_director.py::test_an_unexpected_failure_fails_the_plan_on_the_last_attempt` (an `Indexer` that raises after `watched`: still `analyzing`/`writing` before the last attempt, then `failed`; 2 × the reservation counted; the index isn't used) |
| I2 a hung yt-dlp | `app/audio.py:91`: `fetch_audio` is bounded by `AUDIO_TIMEOUT_SECONDS = 120` (`:28`); a timeout logs and returns None, so the audio is `failed`. `app/audio.py:41`: `run_yt_dlp` kills and reaps the process when cancelled. The module docstring (`:1-10`) now says it's wired into indexing. | `test_audio.py::test_fetch_audio_gives_up_on_a_yt_dlp_that_hangs` and `::test_run_yt_dlp_kills_the_process_when_it_is_given_up_on` (a real process; after the timeout its pid is gone) |
| m1 certs cached, with a timeout | `app/google_auth.py:83` (`google_certs`): an httpx fetch with a 10 s timeout, cached per URL for `CERTS_CACHE_SECONDS = 300` (`:34`). Verification is still google-auth's (`google.auth.jwt.decode`, what `id_token.verify_token` runs once it has the keys). A non-JSON certs answer is `UPSTREAM_UNAVAILABLE`. The `requests` transport is no longer used. | `test_google_auth.py::test_google_s_certificates_are_fetched_once_while_fresh`, `::test_certificates_that_aren_t_google_s_format_are_an_upstream_failure` |
| m2 clock skew | `app/google_auth.py:115`: `clock_skew_in_seconds=CLOCK_SKEW_SECONDS` (10, `:38`) | `test_google_auth.py::test_a_token_from_a_clock_a_little_ahead_passes` (iat 5 s ahead) |
| m3 unknown outcome counts the reservation | `app/indexing.py` (`RemoteIndexer.index`): a metadata failure or a connect error (`_NEVER_SENT`, `:295`) counts 0. Any other transport error after sending counts the whole reservation (`_all_reserved`, `:304`). A body-less answer counts the whole reservation for a 5xx and 0 for a 4xx or 429 (`:322`). | `test_director.py::test_an_indexer_that_hangs_up_mid_run_counts_the_whole_reservation` (a socket that reads the request and closes); `::test_an_indexer_outage_is_retried_then_fails_the_plan[cloud run down]`, now 2 × the reservation; `::test_an_indexer_or_metadata_server_that_can_t_be_reached_is_retried`, now asserting 0 |
| m4 no API docs | `app/indexer.py:68`: `docs_url=None, redoc_url=None, openapi_url=None` | `test_indexer.py::test_the_indexer_publishes_no_api_docs` (all three answer 404 `NOT_FOUND`) |
| m5 bucket name | `app/settings.py:75`: the `MEDIA_BUCKET` pattern | `test_units.py::test_the_media_bucket_is_a_bucket_name` |
| m6 a ceiling on `maxTokens` | `app/schemas.py:52`: `MAX_PLAN_TOKENS = 2_000_000`, used as `le=` on `IndexRequest.maxTokens` (`:303`) and on `DIRECTOR_TOKENS_PER_PLAN` (`app/settings.py:114`), so a reservation can never exceed the request's bound | `test_units.py::test_a_plan_s_token_cap_has_a_ceiling` |
| m7 stage timing | `app/indexing.py:251`: the `RemoteIndexer` docstring says `writing` is published only once the indexer's answer arrives, and that `watching` covers the whole remote run | (a comment) |
| m8 parentheses | `app/indexing.py:347`: `_plan_error` is one expression | (existing refusal tests) |

Another change: the new `# pyright: ignore[reportUnknownMemberType]` on google-auth's untyped
`jwt.decode` (`app/google_auth.py:114`) has its row in `docs/testing.md`'s exceptions.

### TDD red (before the fixes)
```
E   ImportError: cannot import name 'CERTS_CACHE_SECONDS' from 'app.google_auth'
E   ImportError: cannot import name 'MAX_PLAN_TOKENS' from 'app.schemas'
E       AssertionError: assert ('analyzing', 'writing', None) == ('failed', 'f...LYSIS_FAILED')
FAILED tests/test_director.py::test_a_refusal_from_the_indexer_fails_the_plan_without_a_retry[usage unreadable]
FAILED tests/test_director.py::test_a_refusal_from_the_indexer_fails_the_plan_without_a_retry[result unreadable]
FAILED tests/test_director.py::test_an_indexer_that_hangs_up_mid_run_counts_the_whole_reservation
FAILED tests/test_director.py::test_an_unexpected_failure_fails_the_plan_on_the_last_attempt
FAILED tests/test_indexer.py::test_the_indexer_publishes_no_api_docs
FAILED tests/test_director.py::test_an_indexer_outage_is_retried_then_fails_the_plan[cloud run down]
FAILED tests/test_audio.py::test_fetch_audio_gives_up_on_a_yt_dlp_that_hangs
FAILED tests/test_audio.py::test_run_yt_dlp_kills_the_process_when_it_is_given_up_on
```

### Checks (tails)
- `uv run --project apps/ai ruff check` / `ruff format` / `bun run --cwd apps/ai lint`:
  `All checks passed!`, `Success! No dependency issues found.`
- `bun run --filter @repo/ai check-types`: `0 errors, 0 warnings, 0 notes`
- `bun run --filter @repo/ai test`: `98 passed, 107 deselected`
- `bun run --cwd apps/ai coverage` (unit + integration, stack 5): `TOTAL 1661 0 214 0 100%`,
  `Required test coverage of 100.0% reached`, `205 passed`.
  - The first attempt had 3 failures: stack 5's Postgres crashed and restarted mid-run
    (`untracked child process ... exited with exit code 2`, then `terminating any other active
    server processes`, with a load average near 25). The rerun was clean.
- `bun run lint` (repo): EXIT 0.
