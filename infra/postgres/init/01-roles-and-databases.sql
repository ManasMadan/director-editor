-- Local bootstrap, run once when the Postgres volume is first created. It mirrors what
-- every cluster gets from the CloudNativePG bootstrap and managed roles (deploy/charts/data):
--
--   migrator      owns every schema and table; only migrations connect as it
--   app_<service> one login per service; can only use the tables granted to it in
--                 migrations, and never bypasses row-level security
--
-- Services therefore run locally with exactly the privileges they have in production,
-- so a missing GRANT or an RLS mistake fails here, not after a deploy.
-- Passwords are for local development only.

CREATE ROLE migrator LOGIN PASSWORD 'migrator' NOBYPASSRLS CREATEDB;
CREATE ROLE app_api LOGIN PASSWORD 'app_api' NOBYPASSRLS NOINHERIT;
CREATE ROLE app_worker LOGIN PASSWORD 'app_worker' NOBYPASSRLS NOINHERIT;
CREATE ROLE app_notifications LOGIN PASSWORD 'app_notifications' NOBYPASSRLS NOINHERIT;
CREATE ROLE app_webhooks LOGIN PASSWORD 'app_webhooks' NOBYPASSRLS NOINHERIT;
CREATE ROLE app_ai LOGIN PASSWORD 'app_ai' NOBYPASSRLS NOINHERIT;

-- `app` is created by the image (POSTGRES_DB); hand it to the migrator.
ALTER DATABASE app OWNER TO migrator;
-- template0 avoids collation-version mismatches inherited through template1.
CREATE DATABASE app_test OWNER migrator TEMPLATE template0;
-- Prisma's shadow database, used by `prisma migrate dev` to detect drift.
CREATE DATABASE app_shadow OWNER migrator TEMPLATE template0;

-- Extensions need a superuser, so they are created here rather than in migrations.
\connect app
REVOKE ALL ON DATABASE app FROM PUBLIC;
GRANT CONNECT ON DATABASE app TO app_api, app_worker, app_notifications, app_webhooks, app_ai;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

\connect app_test
REVOKE ALL ON DATABASE app_test FROM PUBLIC;
GRANT CONNECT ON DATABASE app_test TO app_api, app_worker, app_notifications, app_webhooks, app_ai;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

\connect app_shadow
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
