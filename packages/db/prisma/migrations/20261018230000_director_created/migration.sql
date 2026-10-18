SET lock_timeout = '5s';

-- Templates a member describes rather than indexes (apps/ai/app/create.py): a plan with
-- source 'created', written by Gemini from the member's brief and photos, its storyboard
-- cards drawn as images of origin 'storyboard'. Expand only: a nullable column and wider
-- checks, which the previous release never writes past.

-- The member's brief: what they typed and their answers to Director's questions
-- ({text, messages, photos}), kept so a created plan is shot with it in mind.
ALTER TABLE ai.director_plan ADD COLUMN "brief" JSONB;

-- Wider checks. Dropped and added NOT VALID, so adding scans nothing (every existing row
-- passes the old, narrower check); a later migration validates them.
ALTER TABLE ai.director_plan
  DROP CONSTRAINT director_plan_source_check,
  ADD CONSTRAINT director_plan_source_check
    CHECK (source IN ('seed', 'user', 'created')) NOT VALID;

ALTER TABLE ai.director_asset
  DROP CONSTRAINT director_asset_origin_check,
  ADD CONSTRAINT director_asset_origin_check
    CHECK (origin IN ('default', 'created', 'upload', 'stock', 'storyboard')) NOT VALID;

-- A storyboard card is drawn by Nano Banana like a default, so it counts against the
-- member's 30 images a day too (uploads and stock still don't).
CREATE OR REPLACE FUNCTION ai.images_today(user_id uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(*)::integer FROM ai.director_asset AS asset
   WHERE asset.user_id = images_today.user_id
     AND asset.origin IN ('default', 'created', 'storyboard')
     AND asset.created_at > now() - interval '1 day';
$$;

-- How many templates a member has described in the last day, in every workspace: their
-- own limit (apps/ai/app/create.py), counted apart from the one Short they may index.
-- Owned by the table's owner, so it reads past row-level security (director_plan's
-- owner_functions policy); it answers only a count.
CREATE OR REPLACE FUNCTION ai.created_today(user_id uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(*)::integer FROM ai.director_plan AS plan
   WHERE plan.created_by = created_today.user_id
     AND plan.source = 'created'
     AND plan.status <> 'failed'
     AND plan.created_at > now() - interval '1 day';
$$;
REVOKE EXECUTE ON FUNCTION ai.created_today(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.created_today(uuid) TO app_ai;
