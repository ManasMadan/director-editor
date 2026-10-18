-- Fail fast instead of queueing behind long transactions: a migration that cannot take
-- its locks within 5s aborts, rather than blocking every query on the table meanwhile.
SET lock_timeout = '5s';

-- What each take shows and says (transcript with word times, what's visible, moments,
-- quality), written with its review so the editor can find a take by description. A
-- nullable column: no rewrite, the running release ignores it, and the ai service's
-- existing table grant covers it.
ALTER TABLE ai.director_take ADD COLUMN take_index JSONB;
