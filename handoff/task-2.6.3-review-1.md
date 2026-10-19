(Review 1 of task 2.6.3 — controller rulings in CAPS; file:line refer to your branch at cebb32a.)

RULING — take the reviewer's "stronger alternative", which fixes Important 1, 2 and 3 together:
- MOVE the media keys OFF ShotPlan: storyboardKey/previewKey per shot index and musicKey become fields of the SEED ENTRY (directorSeedSchema in packages/contracts/src/director-seeds.ts, next to audioKey; the Python SeedTemplate/seed models likewise), e.g. `media: {music?: key, shots?: [{storyboard?: key, preview?: key}] }` or flat arrays keyed by shot index — your call, keep it simple. ShotPlan (Python and zod) goes back to having no storage paths. seeds:media writes there; seeds:build keeps them per the same keep-if-unchanged rule.
- The API builds the media links from the BUNDLED directorSeeds looked up by the row's videoId — only for `source === "seed"` rows, only when the row's plan has the same shot count as the committed seed (so an old copy never shows wrong scenes) — never from the stored row. This makes existing workspaces get media with no data migration (Important 3).
- Validate every key: zod `mediaKey` pattern `^seed-media/<videoId>/(shot-(\d{1,2})\.(png|jpg|mp4)|music\.(mp3|wav))$` checked at load (the committed file fails at api start-up if wrong), the captured shot index equal to the shot's position; the Python fields carry the same pattern so seeds:media/seeds:build fail early. Integration test: a seed row whose plan carries a foreign key (e.g. files/<other-org>/take.webm) gets no link.
- SIGN MEDIA ONLY IN `director.plan` (Important 2): toPlan(row, {media}) — library() and index() pass media:false; split plan() so the router's director.plan signs media and an internal planOf(...) without media serves shots() and the Live gateway (server.ts:80). Update the integration tests (library → no media URLs; director.plan per seed → URLs) and the MEDIA_READ_EXPIRES_S comment.

Minor
4. director.py:796 — becomes moot once keys leave ShotPlan; confirm the reviewer's prompt carries no storage paths.
5. seed_media.py:217 — the 40-clip cap counts saved keys only: count billed generations across runs (e.g. a small ledger file next to the script output, or upload before discarding) so the cap bounds billing.
6. seed_media.py:518 — bound --concurrency (1..8).
7. seed_media.py:516 — --bucket required only when not --dry-run.
8. limits.test.ts:63 — the parity test also pins maxLength/pattern of the media key fields between zod and Python.
9. apps/ai/CLAUDE.md — say --bucket must be the bucket the API serves from (locally the keys 404 unless pointed at GCS).

Do NOT regenerate the media (it's all in the bucket); just move the keys in director-seeds.json to the new place (a one-off transform in your script or by hand-editing JSON, then validate).
