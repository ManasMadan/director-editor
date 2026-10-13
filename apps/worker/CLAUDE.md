# apps/worker

NestJS worker, port 3002 (health only). Relays outbox events to the queues, writes the
audit log, checks uploads (ClamAV) and runs scheduled maintenance.

## Commands (from the repo root)

- Unit tests: `bun run --filter @repo/worker test`
- Integration tests (needs storage and ClamAV): `bun run db:up:full`, then
  `bun run --filter @repo/worker test:integration`

## Where things are

- `src/outbox/sources.ts`: the schemas the relay drains, and the checklist for a service
  that starts emitting events. `relay.service.ts`: the relay. `event-bus.ts`: the
  `EventBus` seam (BullMQ today).
- `src/audit/audit.processor.ts`: event to audit row, deduplicated on the event id.
- `src/maintenance/maintenance.processor.ts`: `SCHEDULES` (cron, UTC) and `run()`.
- `src/files/`: upload scanning and storage cleanup.
- `src/realtime/`: pushes `todo.*` events to connected clients.

## Gotchas

- The relay wakes on `LISTEN outbox`, which needs a direct (non-pooled) connection:
  `WORKER_DATABASE_DIRECT_URL`. Everything else uses the pooled URL.
- The relay locks rows with `FOR UPDATE SKIP LOCKED`, so several replicas are safe;
  delivery is at least once, and every consumer must be idempotent.
- Retention runs through `SECURITY DEFINER` purge functions, not table privileges. A
  new retention task needs its function and `GRANT EXECUTE` in a migration.
- Production refuses `FILE_SCANNER=none` when uploads are on.
