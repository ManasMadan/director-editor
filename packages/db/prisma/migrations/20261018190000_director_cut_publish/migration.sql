SET lock_timeout = '5s';

-- Publishing a cut to YouTube runs in apps/api, with the member's own Google sign-in
-- (apps/api/src/modules/publish), and records how far it got on the cut: uploading while
-- the video goes up, then published with YouTube's id for it and the privacy YouTube
-- actually gave it, or failed. Until now the API could only read the cuts, which apps/ai
-- owns; going through the AI service for these three writes would be an HTTP hop for
-- nothing it checks.
--
-- So the API may update exactly those columns, and updated_at, which every write to a
-- cut keeps current (it's also how a publish that was cut off mid-upload is told from
-- one still going). It still can't insert, delete, or change a cut's title, picks, file
-- or owner, and row-level security still holds it to the workspace in app.org_id.
--
-- A privilege only: the previous release never uses it.
GRANT UPDATE (publish_status, youtube_video_id, visibility, updated_at)
  ON ai.director_cut TO app_api;
