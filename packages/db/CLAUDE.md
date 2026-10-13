# packages/db

Prisma schema, migrations, the client factory and the tenancy helpers. Every service
imports its client from here; Python mirrors the tables in `apps/ai/app/db/models.py`.

## Commands (from the repo root)

- New migration from schema changes: `bun run db:migrate`
- Apply migrations: `bun run db:deploy`. Browse data: `bun run db:studio`
- Regenerate the client: `bun run gen`
- Migration safety (Squawk): `bun run db:lint`
- Schema, migrations and database agree: `bun run --filter @repo/db drift`
- Tests (RLS, grants, factories; integration only, no unit tests here):
  `bun run --filter @repo/db test:integration`
- Backup and restore check: `bun run db:restore-drill`
- Wipe and re-migrate the local database (asks first): `bun run db:reset`

## Where things are

- `prisma/schema/*.prisma`: one file per Postgres schema; conventions in `base.prisma`.
- `prisma.config.ts`: migrations connect as `migrator` (`MIGRATOR_DATABASE_URL`) with
  `app_shadow` as the shadow database.
- `src/client.ts`: `createDb` / `createDatabase` (`read` and `write`, the read-replica
  seam; both the primary today), with statement and idle-in-transaction timeouts.
- `src/tenancy.ts`: `withTenant`, `tenantTx`, `withUser`, `userTx`, `transaction`, `Tx`.
- `src/testing/`: `prepareTemplate`, `createTestDatabase` (`urlFor(role)`), `factories`.
- `test/security.test.ts`: proves RLS and least privilege as the real roles.

## Gotchas

- Roles and extensions are created by `infra/postgres/init/01-roles-and-databases.sql`
  (once, when the volume is new), not by migrations. A change there reaches a local
  database only after `bun run docker:clean` (which deletes local data), and needs the
  same change in the CloudNativePG cluster (`deploy/charts/data`).
- Local passwords equal role names (`app_api:app_api`); that file is for development
  only.
- Integration tests clone a migrated template database; it is rebuilt when a
  migration's checksum changes.
- `drift` ignores only the pgvector HNSW index Prisma cannot express (`scripts/drift.ts`).
