---
paths:
  - "apps/ai/**"
  - "packages/ai-client/**"
---

# apps/ai (Python)

- Tooling is uv only: `uv add <pkg>` (never pip, never edit `uv.lock`). Checks run
  through turbo from the root (`bun run lint`, `bun run check-types`, `bun run test`),
  or directly as `uv run --project apps/ai ruff check apps/ai`.
- basedpyright runs in strict mode with `reportAny` and `reportExplicitAny` on, tests
  included. Type everything; where a library hands back `Any` (a parsed JSON body, a
  Redis reply), validate it with a Pydantic model or `TypeAdapter`, or narrow it with
  `isinstance` (a `Protocol` can say what you use of an untyped client). `typing.cast`
  checks nothing, so it counts as a suppression: refused unless docs/testing.md lists it. `# pyright: ignore[<rule>]` is only for untyped third-party APIs, always
  with the rule named and a reason after it (`# pyright: ignore[rule]  # why`); an ignore
  that no longer suppresses anything is an error. No file-level relaxations.
- ruff adds async, FastAPI, timezone, pytest, bandit, blind-except, print and annotation
  checks to the defaults, and Biome's complexity limits (McCabe 15, at most 12 branches
  and 50 statements a function). Output goes through `app/log.py`, not `print`.
- deptry (in `bun run lint`) fails on a dependency nothing imports, an import that isn't
  a declared dependency (a transitive one included), and a dev dependency the service's
  code imports: `uv add` what you import.
- Request and response models live in `app/schemas.py`. Constrain every field
  (`Field(min_length=..., max_length=..., ge=..., le=...)`, `Literal` for enums): the
  constraints are both runtime validation and the OpenAPI document. Request models take
  `model_config = REQUEST` (strict, unknown fields refused): only apps/api calls this
  service, so a mismatch is a bug to surface, not input to coerce.
- The TypeScript side reads this service through `packages/ai-client`, generated from
  `apps/ai/openapi.json`. After changing a route or model run `bun run gen` and commit
  `openapi.json` and the regenerated client. `operation_id` becomes the TS function name.
- `app/contracts/**` is generated from `packages/jobs` (datamodel-codegen). Do not edit
  it; change the zod schema in `packages/jobs` and run `bun run gen`. The edit and Bash
  guards refuse writes to it.
- Errors: `raise AppError("CODE", params)` from `app/errors.py`. The code is the
  generated `ErrorCode` Literal (from `packages/contracts/src/errors.ts`) and the status
  comes from the catalog, never from the call. Anything else becomes `INTERNAL`.
- Settings come from `app/settings.py` (`get_settings()`); new variables go there and
  in `.env.example`. Production refuses the local stand-ins (`local:*` models,
  `hashing` embeddings); keep it that way.
- Database: Prisma in `packages/db` owns the DDL. SQLAlchemy models in `app/db/models.py`
  mirror it and `tests/test_models_match_db.py` fails when they drift. Tenant data only
  through `tenant(org_id)` in `app/db/session.py`, which sets `app.org_id` for RLS.
- Every route except health needs the caller JWT (`CallerDep` in `app/auth.py`).
- Tests are `tests/test_*.py`. Anything needing Postgres, Redis or a local HTTP server is
  marked `pytest.mark.integration` (excluded by default; `bun run test:integration` runs
  them). Coverage is 100% of lines and branches of `app/` and `evals/`, unit and
  integration together, with nothing omitted: a line no test reaches gets a test or goes. Providers are exercised
  through the local fakes in `tests/fakes.py` (OpenAI's API, an OTLP collector), which
  speak the real protocol.
  Model behaviour is tested with the local stand-ins and the evals (`bun run --cwd
  apps/ai evals`), not by mocking the provider.
