(Review 1 of tasks 2.1.3+2.1.5 — fix these; file:line refer to your branch at cae0a28.)

Important
1. director.py:553 / indexing.py:272,289 — `analyze` catches only IndexFailed (the old code caught every Exception from index_short). A pydantic ValidationError from RemoteIndexer (a 200 body that isn't a valid IndexResult, or error params that don't parse as TokenUsage — realistic with version skew, the indexer is deployed by hand) or a DB error inside watched() escapes _fail_plan; on BullMQ's final attempt nothing fails the plan, so it stays `analyzing` forever, still counts under the one-index partial index, and settles at 0 tokens. Fix: in RemoteIndexer turn a malformed success/error body into IndexFailed("DIRECTOR_ANALYSIS_FAILED", retryable=False, …); AND have `analyze` fail the plan on any other exception when `final` (keep re-raising for BullMQ). Test: the indexer answers 200 with `{}` and the plan ends `failed`.
2. indexing.py:242 via audio.py run_yt_dlp — yt-dlp's communicate() has no time limit (breaks "every outbound call has a timeout"); remote: a hung yt-dlp hits Cloud Run's 900 s, the 504 is retried and Gemini re-indexes (usage lost); in-process: the job hangs in `writing`. Fix: bound the capture (e.g. asyncio.timeout(120) around fetch_audio) and kill the subprocess on cancel/timeout in run_yt_dlp; a timeout is audio status `failed`. Update audio.py:6's docstring ("Not wired into indexing yet").

Minor (do them)
1. google_auth.py:96 — Google's certs fetched per request with google-auth's default 120 s timeout: cache them (a module-level cached Request or a small TTL cache keyed on certs_url) and use a 10 s timeout.
2. google_auth.py:96 — clock_skew_in_seconds=0: pass 10 (a 1 s VM/Cloud Run skew otherwise 401s permanently).
3. indexing.py:269 / _refused — unknown-outcome failures (transport error after send, 5xx/504 without body) settle at 0 tokens: settle the full reservation when the outcome is unknown; 0 only when the request clearly never reached the indexer (connect error, metadata failure).
4. indexer.py:63 — docs/redoc/openapi routes are open: `docs_url=None, redoc_url=None, openapi_url=None`, test /openapi.json → 404.
5. settings.py:72 — MEDIA_BUCKET format check `^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$`.
6. schemas.py:298 — `maxTokens` needs an upper bound (le= the largest allowed DIRECTOR_TOKENS_PER_PLAN).
7. Document that on the remote path `writing` is published only after the indexer returns (stage timing), in the code comment.
8. indexing.py `_plan_error` — drop the redundant parentheses.

Accepted (no change): realtime `director.changed` stays a data-less nudge; clients read plan.stage after refetching (packages/contracts/src/realtime.ts design). DIRECTOR_VIDEO_UNREADABLE having no producer: leave it (the controller tracks it).
