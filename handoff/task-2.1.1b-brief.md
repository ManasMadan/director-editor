# Task 2.1.1b: every Gemini call in apps/ai reaches Vertex's `global` location

## Why

apps/ai calls Vertex AI in express mode (`GOOGLE_VERTEX=true`, `GOOGLE_API_KEY` = a Vertex
API key bound to a service account). With an API key, google-genai 2.30.1 drops any
project/location (`_api_client.py:764-770`) and sends
`https://aiplatform.googleapis.com/v1beta1/publishers/google/models/<model>:generateContent`,
which Vertex routes to `us-central1`. `gemini-4-argon` (INDEX_MODEL) is not served there:
it answers 404 `Publisher model projects/1053522546520/locations/us-central1/.../gemini-4-argon
was not found`, so every Short is silently indexed by INDEX_FALLBACK_MODEL instead. That
happens locally and in production.

The same key works against the global location when the model is addressed by its full
resource name (verified by the controller, 2026-10-18, HTTP 200 for both gemini-4-argon and
gemini-3.8-flash):
`https://aiplatform.googleapis.com/v1/projects/<project>/locations/global/publishers/google/models/<model>:generateContent`.
google-genai passes a model name that starts with `projects/` through unchanged
(`_api_client.py:1470-1481`), so pydantic-ai's `GoogleModel` can be given that resource name.

## What to build

1. `apps/ai/app/settings.py`: add `google_cloud_project: str | None` (alias
   `GOOGLE_CLOUD_PROJECT`, min_length 1) and `vertex_location: str` (alias
   `VERTEX_LOCATION`, default `"global"`, min_length 1). When `GOOGLE_VERTEX` is true,
   `GOOGLE_CLOUD_PROJECT` is required: refuse to start without it, the way the existing
   validators refuse a missing key (Principle 2: validate at the boundary).
2. `apps/ai/app/director.py`: one function builds every Gemini model the service uses
   (`create_director_model`, `create_index_model`, and any other `GoogleModel(` in
   apps/ai/app). On Vertex, it addresses the model as
   `projects/{project}/locations/{location}/publishers/google/models/{name}`; on the
   Gemini API (`GOOGLE_VERTEX=false`, tests' fake Google), it uses the bare name as now.
   One implementation, no copy per call site.
3. Everything that records or reports a model name keeps the SHORT name
   (`gemini-4-argon`, never the resource path): `DirectorPlan.model`, the usage ledger's
   model, logs, error bodies, budgets. Check every place that reads `model_name` off a
   pydantic-ai model or result.
4. `.env.example`, `docs/environment.md`: document `VERTEX_LOCATION` (default `global`, why:
   newer models such as gemini-4-argon are served only there) and that apps/ai now also
   reads `GOOGLE_CLOUD_PROJECT` when `GOOGLE_VERTEX=true`. The chart: give the ai and
   ai-worker containers `GOOGLE_CLOUD_PROJECT` (the production project id is
   `project-18e15b18-c92e-44bb-9bf`, set it in `deploy/environments/production/stack.yaml`
   the way other non-secret per-environment values are set), with the values.schema.json
   entry and a helm-unittest case (`.claude/rules/infra.md`).

## Tests (TDD: failing first)

- Unit: with `GOOGLE_VERTEX=true`, project `p` and the default location, the model the
  factory builds sends its request to a path containing
  `projects/p/locations/global/publishers/google/models/gemini-4-argon` (assert on the
  request the test's fake Google receives, or on the model's name, whichever the existing
  tests' style supports). With `GOOGLE_VERTEX=false`, the bare name as before.
- Unit: settings refuse `GOOGLE_VERTEX=true` without `GOOGLE_CLOUD_PROJECT`.
- Integration: an indexing run on Vertex settings records `plan.model == "gemini-4-argon"`
  and the usage ledger's model as the short name, not the resource path.
- 100% coverage of apps/ai stays; ruff, basedpyright strict, `bun run gen` drift-free,
  `bun run charts:check`.

## Live verification (required, through the app's own code path)

Not through `gcloud` credentials: through the app's real settings and provider, with the
repo's `.env` (which holds the express key; never print or read it):
`bun --env-file=.env run uv run --project apps/ai python <your scratch script>` that builds
`Settings()` and calls the real index-model factory, then runs one indexing of seed
`_HonL1arbaA` with INDEX_MODEL=gemini-4-argon. Show that the request went to the global
resource path (HTTP 200 in the httpx log) and that the plan's recorded model is
`gemini-4-argon`, not the fallback. `.env` needs `GOOGLE_CLOUD_PROJECT` set: it already has
it if `grep -c '^GOOGLE_CLOUD_PROJECT=.' .env` prints 1 (never print the line itself); if
not, set it with `bun run env:set GOOGLE_CLOUD_PROJECT=project-18e15b18-c92e-44bb-9bf`.

## Constraints

Global constraints of the plan apply (no fakes outside tests, no casts or `any`, every
env var in src settings + .env.example + docs/environment.md in the same change).
Never print a secret.
