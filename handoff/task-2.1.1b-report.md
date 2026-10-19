# Task 2.1.1b report: every Gemini call reaches Vertex's `global` location

(Guard refused writing this report to the shared checkout path given in the task, since
this agent is worktree-isolated; written here instead, at the same relative path inside
the worktree.)

## Setup

Worktree started at `3d5809c` (wrong commit). Reset to the integration branch:

```
git checkout -B worktree-agent-a59b7dce6c83cc33d feat/mm/director-hackathon
```

Now at `50751ff` as required; `bun.lock` was unchanged, so the post-checkout hook's
`bun install` ran and the tree was clean (no `bun run gen` needed; `bun run gen` was run
later anyway, see below, with no drift).

## What changed and why

**`apps/ai/app/settings.py`**
- Added `google_cloud_project: str | None` (alias `GOOGLE_CLOUD_PROJECT`, `min_length=1`)
  and `vertex_location: str` (alias `VERTEX_LOCATION`, default `"global"`, `min_length=1`).
- Added `_vertex_has_a_project`: refuses `GOOGLE_VERTEX=true` without
  `GOOGLE_CLOUD_PROJECT`, the same pattern as the existing `_director_has_a_key`
  validator.

**`apps/ai/app/director.py`**
- Added `_model_address(settings, model_name)`: returns the bare model name on the Gemini
  API, and on Vertex the full resource name
  `projects/{project}/locations/{location}/publishers/google/models/{model_name}`. Raises
  `RuntimeError` if `google_cloud_project` is `None` while `google_vertex` is true — this
  can't happen through `get_settings()` (the new validator refuses it at boot), only
  through a `Settings` built another way, so it's a defensive invariant, not a user-facing
  error; covered by a unit test that bypasses the validator with `Settings.model_construct`.
- Added `create_google_model(settings, model_name)`: the one function that builds every
  `GoogleModel(` in the service, routing every call through `_model_address`.
  `create_director_model` and `create_index_model` now both call it instead of
  constructing `GoogleModel` directly.
- **Important correctness fix inside `Director.__init__`**: before this change it read
  `index_model.model_name` and `index_fallback_model.model_name` off the already-built
  `GoogleModel` objects to get the "short" name for `DirectorPlan.model` and the usage
  ledger. Once `create_google_model` can give a `GoogleModel` the full Vertex resource
  path as its `model_name`, reading it back that way would have leaked the resource path
  into the plan and the ledger. Fixed by having `Director.__init__` (and
  `create_director()`) take the short name as its own explicit parameter
  (`index_model_name`, `index_fallback_model_name`) instead of reading it off the model
  object. `self._model_name` (Director's own model) was already passed this way, so this
  makes the three consistent.

**Tests**
- `apps/ai/tests/test_units.py`: extended `test_director_calls_vertex_ai_when_asked` to
  assert `model_name` on both the Gemini-API and Vertex models (now needs
  `GOOGLE_CLOUD_PROJECT` to build the Vertex one). Added
  `test_vertex_needs_the_cloud_project` (settings refuse `GOOGLE_VERTEX=true` without the
  project), `test_the_index_model_addresses_vertex_at_its_configured_location` (resource
  path with a non-default `VERTEX_LOCATION`, and the bare name off Vertex), and
  `test_vertex_without_a_project_is_a_configuration_bug` (the defensive `RuntimeError`,
  needed for 100% coverage, via `Settings.model_construct` to produce the otherwise
  unreachable state).
- `apps/ai/tests/test_director.py`: refactored the index-fallback test's
  `_client_with_index_fallback` context manager to share a new `_client_with_env` helper
  (one implementation, reused by both the fallback test and the new Vertex test). Added
  `test_indexing_on_vertex_addresses_the_model_by_its_resource_name`: an integration test
  against the local fake Gemini server with `GOOGLE_VERTEX=true`, asserting the plan ends
  up `ready` with `plan.model == GEMINI_MODEL` (the short name), the usage ledger recorded
  under the short name, and that the fake received exactly one request at the Vertex-style
  path (`/v1beta1/projects/.../locations/global/publishers/google/models/{model}:generateContent`),
  never at the Gemini-API path. I determined that exact path empirically (see "TDD
  evidence" below) by running pydantic-ai's real `GoogleCloudProvider` + `GoogleModel`
  against the test fake server with a full resource-name model, since the library's
  exact request shape (api version `v1beta1`, not `v1`) isn't documented and matters for
  a test that has to match it exactly.

**`.env.example`** / **`docs/environment.md`**: added `VERTEX_LOCATION` next to
`GOOGLE_VERTEX` (default `global`, why newer models need it), and a one-line note on the
existing `GOOGLE_VERTEX` and `GOOGLE_CLOUD_PROJECT` entries that apps/ai also reads
`GOOGLE_CLOUD_PROJECT` when `GOOGLE_VERTEX` is true. Left `DIRECTOR_MODEL=gemini-mock`,
`GOOGLE_API_KEY=mock-google-key` and `GOOGLE_VERTEX=false` untouched, per the brief. Edits
are local to the Gemini/Vertex lines, since another agent is rewriting these two files
elsewhere.

**Chart**: `deploy/environments/production/stack.yaml` now sets
`services.ai.env.GOOGLE_CLOUD_PROJECT` and `services.ai-worker.env.GOOGLE_CLOUD_PROJECT`
to `project-18e15b18-c92e-44bb-9bf` (not a secret — the way `notifications.env.EMAIL_FROM`
is already set there). No `values.schema.json` change was needed: the chart's `env` schema
(`$defs.env`) is already a generic `{propertyNames: ^[A-Z][A-Z0-9_]*$, additionalProperties:
{type: [string, number, boolean]}}` map, so any new uppercase env var is already covered
by its existing schema entry; confirmed by `bun run charts:check` rendering and
kubeconform-validating all four environments (local, preview, production, staging) with
no schema error. Added a helm-unittest case in
`deploy/charts/stack/tests/deployment_test.yaml` for each container (`demo-ai`,
`demo-ai-worker`) asserting `GOOGLE_CLOUD_PROJECT` reaches the container's env when set in
values.

## TDD evidence (failing first)

Before touching `settings.py`/`director.py`, I wrote the tests and ran them red:

```
$ uv run --project apps/ai pytest apps/ai/tests/test_units.py -k "vertex or director_calls_vertex or index_model_addresses" -q
...
E       AttributeError: 'Settings' object has no attribute 'google_cloud_project'
...
E       AssertionError: assert 'gemini-4-argon' == 'projects/p/l...emini-4-argon'
...
FAILED apps/ai/tests/test_units.py::test_director_calls_vertex_ai_when_asked
FAILED apps/ai/tests/test_units.py::test_vertex_needs_the_cloud_project
FAILED apps/ai/tests/test_units.py::test_the_index_model_addresses_vertex_at_its_configured_location
3 failed, 27 deselected, 1 warning in 7.16s
```

And the new integration test, before the fix, against `db:up`:

```
$ bun run --filter @repo/ai test:integration -- -k "indexing_on_vertex"
...
>       assert plan.status == "ready"
E       AssertionError: assert 'failed' == 'ready'
...
FAILED tests/test_director.py::test_indexing_on_vertex_addresses_the_model_by_its_resource_name
1 failed, 182 deselected, 1 warning in 7.04s
```

(The plan failed because, without the fix, `GOOGLE_VERTEX=true` still sent the bare model
name, so the fake received it at the Gemini-API-style path, which only had `GEMINI_PATH`
registered, not the Vertex path I registered for this test — a 404 that falls through to
the index fallback model, which also 404s, consistent with the bug the brief describes.)

To get the exact HTTP path for that test (so it would be a real assertion, not a guess), I
ran a small scratch script (not checked in) driving the real `GoogleCloudProvider` +
`GoogleModel` from pydantic-ai against the test suite's own fake HTTP server
(`tests/fakes.py`'s `serve()`), with a full resource-name model and a custom base URL:
confirmed the library sends `POST /v1beta1/projects/p/locations/global/publishers/google/models/test-model:generateContent`
(api version `v1beta1`, despite the brief's manually-curled example using `v1` against the
real Vertex endpoint — pydantic-ai's `GoogleCloudProvider` always asks for `v1beta1`, and
Vertex evidently accepts it, as the live verification below confirms).

After implementing the fix, both are green (see "Tests" below).

## Tests, lint, types, coverage, charts

**Unit tests** (`bun run --filter @repo/ai test`):
```
tests/test_settings_documented.py ..
tests/test_units.py ...............................
================ 110 passed, 74 deselected, 1 warning in 4.49s =================
```

**Integration tests, full apps/ai suite** (`bun run db:up` then
`bun run --filter @repo/ai test:integration`):
```
tests/test_budgets.py ........
tests/test_director.py .................................
tests/test_documents.py ...
tests/test_mcp.py ..........
tests/test_models_match_db.py .
tests/test_providers.py ..
tests/test_service.py ................
tests/test_telemetry.py .
================ 74 passed, 109 deselected, 1 warning in 57.60s ================
```

**Lint** (`bun run --cwd apps/ai lint`):
```
$ uv run ruff check . && uv run ruff format --check . && uv run deptry .
All checks passed!
70 files already formatted
Scanning 44 files...
Success! No dependency issues found.
```

**Types** (`bun run --filter @repo/ai check-types`):
```
@repo/ai check-types: 0 errors, 0 warnings, 0 notes
```

**`bun run gen`**: ran clean (ai contracts/openapi regenerated, 11 files unchanged); `git
status` showed no diff from it — no route or schema changed, so no drift.

**Coverage** (`bun run --filter @repo/ai coverage`), full apps/ai + evals:
```
app/director.py    301  0  72  0  100%
app/settings.py     56  0  14  0  100%
...
TOTAL              1888  0  258  0  100%
Required test coverage of 100.0% reached. Total coverage: 100.00%
================== 184 passed, 1 warning in 62.84s (0:01:02) ===================
```
(The first run was 99.91%, missing `director.py:209`, the defensive `RuntimeError` guard
— fixed by adding `test_vertex_without_a_project_is_a_configuration_bug`.)

**Charts** (`bun run charts:check`, backgrounded — takes ~2 minutes):
```
✔ deploy/charts/stack: lint
✔ deploy/charts/stack: unit tests
✔ local: stack renders / manifests are valid Kubernetes
✔ preview: stack renders / manifests are valid Kubernetes
✔ production: stack renders / manifests are valid Kubernetes
✔ staging: stack renders / manifests are valid Kubernetes
... (every platform add-on, Argo CD, SOPS check)
[exited with code 0]
```

**Repo-wide `bun run format`/`bun run lint`**: `bun run format` (biome) reformatted an
unrelated pre-existing file, `apps/ai/app/seeds/seeds.json` (JSON array formatting drift
that predates this change, at `50751ff`); I reverted that file since it's out of scope for
this task and another agent could be touching adjacent files. `bun run lint` fails
repo-wide only because of that same pre-existing drift in `seeds.json` (one
`bunx biome check .` error); every other lint step passes, including `@repo/ai:lint`. This
is a pre-existing issue, not something this change introduced or should fix.

## Live verification (through the app's own code path)

`.env` already had `GOOGLE_CLOUD_PROJECT` set (confirmed with
`grep -c '^GOOGLE_CLOUD_PROJECT=.' .env` printing `1`, never the line itself). Ran a
scratch script (not committed) that builds `Settings()` and the real `create_index_model`
factory, then runs one indexing of seed `_HonL1arbaA` with `INDEX_MODEL=gemini-4-argon`
and `GOOGLE_VERTEX=true` forced on the command line:

```
$ INDEX_MODEL=gemini-4-argon GOOGLE_VERTEX=true PYTHONPATH=apps/ai bun --env-file=.env run \
    uv run --project apps/ai python <scratch script>

google_genai._api_client: The user provided Vertex AI API key will take precedence over the project/location from the environment variables.
model: google-cloud:projects/project-18e15b…blishers/google/models/gemini-4-argon
httpx2: HTTP Request: POST https://aiplatform.googleapis.com/v1beta1/projects/project-18e15b18-c92e-44bb-9bf/locations/global/publishers/google/models/gemini-4-argon:generateContent "HTTP/1.1 200 OK"
settings.google_vertex = True
settings.google_cloud_project is set = True
settings.vertex_location = global
settings.index_model (short name) = gemini-4-argon
model.model_name (what reaches Gemini) = projects/project-18e15b18-c92e-44bb-9bf/locations/global/publishers/google/models/gemini-4-argon
recorded plan model (short name) = gemini-4-argon
plan title = 3-Ingredient No-Oven Oreo Cake
plan shots = 9
```

The httpx2 log line shows the real request reaching the global resource path with HTTP
200, for `gemini-4-argon` (not the fallback), and the recorded plan model is the short
name `gemini-4-argon`, not the resource path. The plan it got back (title "3-Ingredient
No-Oven Oreo Cake", 9 shots) matches seed `_HonL1arbaA` ("3-Ingredient Oreo Cake!").

No secret was printed at any point: `.env` was never read or echoed, only loaded by
`bun --env-file=.env` into the child process's environment.

## Status

DONE

One-line test summary: 110 unit + 74 integration (apps/ai) pass, 100% coverage, lint/types/gen/charts clean, live Vertex global-path request confirmed with HTTP 200 and the plan recorded under the short model name.

Concerns:
- `bun run lint` fails repo-wide only due to a pre-existing, unrelated formatting drift in `apps/ai/app/seeds/seeds.json` (present at the base commit `50751ff`, untouched by this change); flagging it in case another task should pick it up.
- I did not touch `values.schema.json`: its `env` map is already schema'd generically for any `^[A-Z][A-Z0-9_]*$` key, so `GOOGLE_CLOUD_PROJECT` needed no new entry; `bun run charts:check` confirms this renders and validates for every environment. Worth a second look if the reviewer expected an explicit schema line.
- The Vertex integration test's HTTP path (`v1beta1`, not `v1`) was determined empirically against the installed `google-genai`/`pydantic-ai` versions rather than from documentation; it could change on a library upgrade, in which case the test's `vertex_path` constant would need updating (it would fail loudly, not silently).
