/**
 * Tenant isolation, enforced by Postgres row-level security.
 *
 * Tenant tables have a policy that only exposes rows whose org_id equals the
 * transaction-local setting `app.org_id`. These helpers set it for every query:
 *
 *   const db = withTenant(database.read, orgId);
 *   await db.todo.findMany();                          // only this org's rows
 *
 *   await tenantTx(database.write, orgId, async (tx) => {
 *     await tx.todo.update(...);                        // state change ...
 *     await tx.appOutboxEvent.create(...);              // ... and its event, atomically
 *   });
 *
 * Why this shape: the setting must be applied inside the same transaction as the query,
 * because the pooler (PgBouncer, transaction mode) hands each transaction a different
 * server connection. `withTenant` sends each query as a two-statement batch, so no
 * connection is held between statements. Multi-statement units use `tenantTx`, an
 * interactive transaction that holds one connection until it ends, so it must contain
 * database calls only: never await HTTP, Redis or queues inside it.
 *
 * Nested `$transaction` on a tenant client is blocked: Prisma would run each operation
 * in its own transaction there, silently breaking atomicity.
 */
import type { OrgId, UserId } from "@repo/contracts/ids";
import type { Db } from "./client";
import type { Prisma } from "./generated/prisma/client";

type Scope = "app.org_id" | "app.user_id";

/** Sets the row-level security scope for the rest of the transaction. */
const setScope = (client: Db | Prisma.TransactionClient, scope: Scope, id: string) =>
  client.$executeRaw`SELECT set_config(${scope}, ${id}, true)`;

/** A client whose every query runs with `scope` set to `id` (see the module comment). */
function scoped(db: Db, name: string, scope: Scope, id: string, useInstead: string) {
  return db.$extends({
    name,
    client: {
      $transaction(): never {
        throw new Error(useInstead);
      },
    },
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await db.$transaction([setScope(db, scope, id), query(args)], {
            maxWait: 10_000,
          });
          return result;
        },
      },
    },
  });
}

export const withTenant = (db: Db, orgId: OrgId) =>
  scoped(
    db,
    "tenant",
    "app.org_id",
    orgId,
    "Use tenantTx() for multi-statement units on tenant data.",
  );

/**
 * Like withTenant, for rows owned by one user rather than an organization (their
 * notifications, preferences, devices): row-level security on `app.user_id` scopes
 * every query to that user.
 */
export const withUser = (db: Db, userId: UserId) =>
  scoped(
    db,
    "user",
    "app.user_id",
    userId,
    "Use userTx() for multi-statement units on per-user data.",
  );

/** Like tenantTx, for per-user data (see withUser). */
export function userTx<T>(db: Db, userId: UserId, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await setScope(tx, "app.user_id", userId);
    return fn(asTx(tx));
  }, TX_OPTIONS);
}

declare const txBrand: unique symbol;

/**
 * A client that is inside a database transaction. Only `tenantTx` and `transaction`
 * produce one, so APIs that must run inside a transaction (writing an outbox event
 * together with the change it describes) accept `Tx` and cannot be called with a plain
 * client: forgetting the transaction is a compile error, not a lost event.
 */
export type Tx = Prisma.TransactionClient & { readonly [txBrand]: true };

/** Brands a transaction's client: the one place a Tx is made. */
// type-coverage:ignore-next-line
const asTx = (tx: Prisma.TransactionClient) => tx as Tx;

const TX_OPTIONS = { maxWait: 10_000, timeout: 5_000 } as const;

export function tenantTx<T>(db: Db, orgId: OrgId, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await setScope(tx, "app.org_id", orgId);
    return fn(asTx(tx));
  }, TX_OPTIONS);
}

/** A transaction on non-tenant data (same rules as tenantTx: database calls only inside). */
export function transaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction((tx) => fn(asTx(tx)), TX_OPTIONS);
}
