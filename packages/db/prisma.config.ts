/**
 * Prisma CLI configuration (Prisma 7+).
 *
 * Migrations run as the `migrator` role, which owns every schema; services connect as
 * their own least-privileged roles (DATABASE_URL). Our package scripts load the root
 * .env, so these variables are set by the time this file is evaluated.
 *
 * The datasource is only omitted when no URL is set (e.g. `prisma generate` in a
 * Docker build stage). Commands that need a database then fail loudly; the CI drift
 * check sets the URL explicitly, because `migrate diff` without one exits 0 silently.
 */
import { defineConfig } from "prisma/config";

const url = process.env.MIGRATOR_DATABASE_URL;
const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema",
  migrations: { path: "prisma/migrations" },
  ...(url ? { datasource: { url, ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}) } } : {}),
});
