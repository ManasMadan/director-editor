SET lock_timeout = '5s';

-- The AI service reviews each take against the member's version of its shot ("at your
-- desk" in place of the original's "in the market") and what they've told Director
-- ("Inside"), read when the review runs (apps/ai app/your_version.py). It reads the
-- version and the columns that find it, nothing more: no write, and row-level security
-- (tenant_isolation, forced) holds it to the workspace in app.org_id. Expand only: a grant
-- the previous release doesn't use. USAGE on the app schema was granted with the
-- recording tables (20261018221000_director_take_picks).
GRANT SELECT (org_id, user_id, video_id, version) ON app.director_version TO app_ai;
