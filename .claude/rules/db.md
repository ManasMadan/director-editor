---
paths:
  - "packages/db/**"
  - "infra/postgres/**"
  - "apps/ai/app/db/**"
---

# Database and migrations

- The schema is `packages/db/prisma/schema/*.prisma`, one file per Postgres schema
  (`auth`, `app`, `audit`, `webhooks`, `notifications`, `files`, `billing`, `ai`) plus
  `base.prisma`. Conventions from `base.prisma`: `uuidv7()` ids, `Timestamptz(3)`,
  snake_case through `@map`/`@@map`, `@@schema` on every model.
- Each Postgres schema has one owning service that writes to it. Other services get
  `SELECT` on specific tables (sometimes specific columns), granted in the migration.
- Workflow: edit the schema, `bun run db:migrate` to generate and apply the migration,
  then `bun run gen`. RLS, grants, checks and functions are hand-written into the same
  migration before it is committed. The edit hook allows that while the migration isn't
  on master, and refuses migrations that are.
- Never edit a migration that is on master. Fix forward with a new one.
- Every migration starts with `SET lock_timeout = '5s';`.
- Expand/contract. The previous release runs against the new schema during a rollout,
  so each migration must work with both versions: add nullable or defaulted columns,
  backfill, switch the code, and drop or tighten in a later release. Never rename or
  drop a column the running code reads.
- On tables that already have rows: foreign keys and checks go in `NOT VALID`, and
  `VALIDATE CONSTRAINT` in a later migration (in the same file it runs in the same
  transaction and holds the lock during the scan). Indexes use
  `CREATE INDEX CONCURRENTLY`, alone in its own migration (it cannot run inside the
  transaction Postgres wraps a multi-statement file in).
- A tenant table (has `org_id`) gets, in the same migration:
  `ENABLE` and `FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy using
  `org_id = nullif(current_setting('app.org_id', true), '')::uuid` for `USING` and
  `WITH CHECK` (copy from `20260928205424_init`). Per-user tables use `own_rows` on
  `app.user_id` (see `20260929120000_files`).
- Grants in the same migration: `GRANT USAGE ON SCHEMA` and the narrowest table or
  column privileges for each `app_<service>` role that needs it. Only `app_api` on
  `auth` and `app` has default privileges; every other schema needs explicit grants.
  Roles never get DDL or `BYPASSRLS`.
- `SECURITY DEFINER` functions: `SET search_path = pg_catalog, pg_temp`,
  `CREATE OR REPLACE`, `REVOKE EXECUTE ... FROM PUBLIC`, then grant to the one role
  that calls it. A table such a function touches under forced RLS needs an
  `owner_functions` policy `TO migrator` (see `20260929090000_push_devices`);
  `packages/db/test/security.test.ts` fails on any that lacks one.
- Extensions need a superuser: add them to `infra/postgres/init` and to the cloud
  setup, not to a migration.
- Database code must keep working behind a transaction-mode pooler (PgBouncer): the
  charts don't run one yet, but the tenancy helpers are built for it, and it's how
  connections scale. There each transaction may run on a different server connection,
  so session state doesn't survive: a session
  `pg_advisory_lock` can be taken on one connection and never released, `SET` without
  `LOCAL` leaks to other clients, and `LISTEN` hears nothing. Use
  `pg_try_advisory_xact_lock` inside the transaction, `set_config(..., true)`, and the
  direct URL (`*_DATABASE_DIRECT_URL`) for anything that needs a session.
- Checks: `bun run db:lint` (Squawk on migrations changed since master; a justified
  exception is `-- squawk-ignore <rule>` with the reason above it),
  `bun run --filter @repo/db drift` (schema vs migrations), and
  `bun run --filter @repo/db test:integration` (`test/security.test.ts` checks forced
  RLS and least privilege). Use the `migration-reviewer` agent before shipping one.
- Older migrations (`20260929100000_phone_numbers`, `20260929170000_api_key_organization`)
  predate the lint and skip some of this; do not copy them.
