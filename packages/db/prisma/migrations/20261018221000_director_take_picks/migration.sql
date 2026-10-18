SET lock_timeout = '5s';

-- Director's picks with reasons (the editor shows its pick first, with a line on why),
-- the member's own choice made while shooting ("use the second one"), and takes the
-- post-session pass finds in the whole recording after Done (a great line said while
-- rehearsing).
--
-- Expand only: nullable columns and one with a constant default, which Postgres adds
-- without rewriting the table. The previous release never reads or writes them. The
-- table's row-level security and grants (apps/ai owns it) cover new columns as they are.
ALTER TABLE ai.director_take
  ADD COLUMN reason text,
  ADD COLUMN chosen_at timestamptz(3),
  ADD COLUMN origin text NOT NULL DEFAULT 'shoot';
