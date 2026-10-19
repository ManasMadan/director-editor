### Task 1.2: Rebrand and hide workspaces

- [ ] `common.appName` = "Director"; better-auth `appName`, 2FA issuer, passkey `rpName` = "Director"; page titles, email sender name "Director".
- [ ] Remove from UI: workspace switcher, members, invitations, workspace settings (routes 404). Keep the personal workspace creation.
- [ ] Test: `apps/web` e2e smoke asserts no "Director-editor" text on `/`, `/sign-in`, `/library`.

---

## Phase 2 — Parallel workstreams (each in its own worktree; 2.2 merges first, its contract is the shared interface)

### Workstream 2.1: Indexing (apps/ai) and the Cloud Run indexer

**Interfaces — Produces:**
- `POST /v1/index` on a new ASGI app `app.indexer:app` (Cloud Run): body `{videoId: str, orgId: UUID, planId: UUID}`; returns `IndexResult {plan: ShotPlan, model: str, audio: {status: "ready"|"failed", objectKey: str|None}}`. Auth: Google ID token, audience = service URL (Cloud Run `--no-allow-unauthenticated`).
- Env (ai): `INDEX_MODEL`, `INDEXER_URL` (empty → index in-process), `MEDIA_BUCKET`.
- Worker publishes realtime `director.changed` with `stage`: `queued | watching | writing | ready | failed`.

