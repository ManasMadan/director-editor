### Task 1.1: Remove starter features

**Files:** per remove-feature's table for: todos + dashboard, documents assistant/RAG/sentiment (Python modules `assistant, documents, embeddings, chunking, summaries, mcp_server` and their routes/queue `ai-ingest`/tables), MCP + OAuth-provider plugins (`mcp`, `jwt`, `cimd`, connected apps, consent page), billing/Stripe/entitlements (`packages/fake-stripe`, webhooks' stripe route, `billing.prisma`, `stripe.yml`), API keys, outbound webhooks, SMS, push, in-app notifications inbox/preferences/digest, audit UI (keep the pipeline), `apps/mobile` + `mobile.yml`, `load/`, `es` locale.
- [ ] Post-sign-in default path becomes `/library` (`auth/hooks/use-next-path.ts`, `proxy.ts`, `user-menu.tsx`, `site-header.tsx`).
- [ ] Auth `billing.entitlements()` callers get a fixed single-member rule.
- [ ] Migrations: contract-phase drops for removed tables in one migration `remove_starter_features` (expand/contract: code stops using them in the same PR; acceptable since production has no data in them).
- [ ] `bun run gen`; regenerate openapi + ai-client; update docs/README/CLAUDE.md tables; commit with `!` (breaking API).

**Verify:** `bun run lint`, `bun run check-types`, `bun run test`, `bun run test:integration`, `bun run charts:check` all pass; `rg -i "todo|stripe|apikey|mcp" apps packages --type ts -l` returns only intentional matches.

