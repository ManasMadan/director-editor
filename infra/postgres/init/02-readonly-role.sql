-- A local-only role for Claude Code's Postgres MCP server (.mcp.json): read-only, and
-- past row-level security, so debugging can look at tenant rows. It exists only in the
-- local compose database: CI runs just 01-roles-and-databases.sql, and the clusters'
-- roles come from the data chart, so no deployed database ever has it.
--
-- Safe to run again: `bun run db:up` reapplies it, so a database made before this file
-- existed gets the role too. It runs in the `app` database as the superuser.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_readonly') THEN
    CREATE ROLE app_readonly LOGIN PASSWORD 'app_readonly' BYPASSRLS NOINHERIT;
  END IF;
END
$$;

-- Read-only by default, and granted nothing that writes.
ALTER ROLE app_readonly SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE app TO app_readonly;

-- Everything the migrator creates from now on, then everything it already has.
ALTER DEFAULT PRIVILEGES FOR ROLE migrator GRANT USAGE ON SCHEMAS TO app_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator GRANT SELECT ON TABLES TO app_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator GRANT SELECT ON SEQUENCES TO app_readonly;
DO $$
DECLARE
  owned text;
BEGIN
  FOR owned IN SELECT nspname FROM pg_namespace WHERE nspowner = 'migrator'::regrole LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO app_readonly', owned);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO app_readonly', owned);
    EXECUTE format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA %I TO app_readonly', owned);
  END LOOP;
END
$$;
