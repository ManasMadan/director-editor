/**
 * Database connections for one service.
 *
 *   const database = createDatabase({ url: env.API_DATABASE_URL, poolMax: env.API_DATABASE_POOL_MAX, service: "api" });
 *   await database.read.todo.findMany(...);   // queries that may be served by a replica
 *   await database.write.todo.update(...);    // writes, and reads that must see them
 *
 * `read` and `write` are the same primary today. Repositories choose one per query, so
 * adding read replicas later is a change in this file only: point `read` at a replica
 * client (Prisma's read-replicas extension) and nothing else moves. Queries that must
 * see their own writes simply use `write`.
 *
 * Every connection is labelled with the service name (visible in pg_stat_activity) and
 * guarded by timeouts, so one runaway query or forgotten transaction cannot hold locks
 * or exhaust the pool.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export interface DatabaseOptions {
  url: string;
  /** Connections this process may hold. The sum over all replicas must fit the server limit. */
  poolMax: number;
  /** Shown as application_name in pg_stat_activity. */
  service: string;
  statementTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
}

export function createDb({
  url,
  poolMax,
  service,
  statementTimeoutMs = 15_000,
  idleInTransactionTimeoutMs = 10_000,
}: DatabaseOptions) {
  const adapter = new PrismaPg({
    connectionString: url,
    max: poolMax,
    application_name: service,
    statement_timeout: statementTimeoutMs,
    idle_in_transaction_session_timeout: idleInTransactionTimeoutMs,
  });
  return new PrismaClient({ adapter });
}

export type Db = ReturnType<typeof createDb>;

export interface Database {
  /** Reads that tolerate replication lag (lists, dashboards, search). */
  read: Db;
  /** Writes, and any read that must observe a write made in the same request. */
  write: Db;
  disconnect(): Promise<void>;
}

export function createDatabase(options: DatabaseOptions): Database {
  const primary = createDb(options);
  return { read: primary, write: primary, disconnect: () => primary.$disconnect() };
}
