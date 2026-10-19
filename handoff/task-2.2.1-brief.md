#### Task 2.2.1: Schema and migration
**Files:** `packages/db/prisma/schema/ai.prisma`, new migration `director_library`, `apps/ai/app/db/models.py`, `apps/ai/tests/test_models_match_db.py`.
- [ ] `DirectorPlan` + `source text not null default 'user' check (source in ('seed','user'))`, `stage text not null default 'queued'`, `audio_status text not null default 'none'`, `audio_key text null`.
- [ ] New `DirectorCut` table `ai.director_cut` (id uuidv7, org_id, plan_id, user_id, title, picks jsonb, file_id → files.file, duration_ms int, publish_status text default 'none', youtube_video_id text null, visibility text null, created_at, updated_at), RLS `tenant_isolation`, grants to `app_ai` and `app_api` (select) per the director migration's pattern.
- [ ] Partial unique index for the limit: `create unique index director_plan_one_user_index on ai.director_plan (created_by) where source = 'user' and status <> 'failed';` **[RF 3]**

