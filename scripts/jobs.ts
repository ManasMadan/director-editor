/**
 * The queues at a glance, and their failed jobs listed, retried or discarded
 * (packages/jobs/src/admin.ts):
 *
 *   bun run jobs                          waiting, active, delayed and failed per queue
 *   bun run jobs failed <queue> [limit]   the latest failed jobs and why
 *   bun run jobs retry <queue> [ids…]     retry those, or every failed job of the queue
 *   bun run jobs discard <queue> <ids…>   delete failed jobs that must never run
 *
 * Uses REDIS_URL (.env). For a deployed environment, forward its Valkey and point at it:
 *   kubectl -n boilerplate port-forward svc/boilerplate-data-valkey 56380:6379
 *   REDIS_URL=redis://:<password from the valkey Secret>@localhost:56380 bun run jobs
 * Fix the cause before retrying: a job retried into the same failure fails again.
 */

import { jobs } from "@repo/jobs/cli";
import { runMain } from "./lib";

await runMain(import.meta, jobs);
