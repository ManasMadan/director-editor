#### Task 2.2.3: Library, index limit, shots, cuts, media procedures
**Files:** `packages/contracts/src/api/director.ts`, `packages/contracts/src/errors.ts`, `apps/api/src/modules/director/*`, `packages/client/src/api/director/*`, `apps/ai/app/director.py`, `apps/ai/app/main.py`.
- [ ] Implement the procedures in the Interfaces block; `index` parses a YouTube URL (watch, shorts, youtu.be), checks `filmable`, counts the user's non-failed `source='user'` plans; unique-violation on the partial index maps to `DIRECTOR_INDEX_LIMIT`. **[RF 3]**
- [ ] Integration tests: `second index by same user → DIRECTOR_INDEX_LIMIT`, `failed index doesn't count`, `concurrent double index → one plan`, `seed copies don't count`, `shots picks highest score and flags needsRetake below 60`, `saveCut rejects another user's file`.
- [ ] Remove the auto-`requestPlan` on the template page (web 2.3 consumes `library`/`index`).

