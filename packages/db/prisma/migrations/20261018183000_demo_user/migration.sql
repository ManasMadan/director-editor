SET lock_timeout = '5s';

-- Director's shared demo account (apps/api/src/auth/demo.ts, made by
-- `bun run --filter @repo/api director:demo-account`) is a user like any other with this
-- flag set: publishing and changes to the account itself are refused for it, since every
-- judge trying Director signs in to the same one.
--
-- A column on auth.user rather than a table of its own: it's one fact about one account,
-- read with the user on every session (better-auth registers it as an additional field,
-- so `session.user.demo` is there without another query), and auth.user already belongs
-- to the API alone. Expand only: a constant default adds the column without rewriting the
-- table (Postgres 11+), and the previous release never reads it.
ALTER TABLE "auth"."user" ADD COLUMN "demo" BOOLEAN NOT NULL DEFAULT false;
