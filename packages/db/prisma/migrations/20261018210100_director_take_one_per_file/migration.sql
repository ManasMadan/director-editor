-- A file is one take (apps/ai's add_take inserts with ON CONFLICT on it): a recorded
-- attempt's clip job run twice adds its take once. Every take so far was made from an
-- upload of its own, so no two rows share a file.
--
-- CONCURRENTLY, so writes to ai.director_take carry on while it builds; it can't run in
-- the transaction a multi-statement file is wrapped in, so this file holds only it, and
-- no lock_timeout (it takes no lock that waits on, or holds up, a write).
-- squawk-ignore require-timeout-settings
CREATE UNIQUE INDEX CONCURRENTLY "director_take_one_per_file" ON "ai"."director_take"("file_id");
