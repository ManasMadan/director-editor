/**
 * Writes domain events to a service's transactional outbox (`<schema>.outbox_event`).
 *
 *   // once per service (apps/api/src/outbox.ts):
 *   export const { emitEvent, emitAnyEvent } = createOutbox("app", events);
 *
 *   await tenantTx(database.write, orgId, async (tx) => {
 *     const todo = await tx.todo.update(...);
 *     await emitEvent(tx, "todo.completed.v1", todo.id, { todoId: todo.id, title: todo.title });
 *   });
 *
 * The event is committed atomically with the change, so it can neither be lost (change
 * committed, event not) nor phantom (event sent, change rolled back). apps/worker relays
 * it to the consumers' queues. The payload is validated against the catalog. The actor
 * and request id come from the request context unless given; the organization is the
 * one given, else the tenant the transaction runs as (tenantTx), else the request's, so
 * an event emitted from a job or a script names its workspace too.
 *
 * Only accepts a transaction client (`Tx`): an event emitted outside a transaction could
 * be committed without its change, so that doesn't compile.
 */
import { Prisma, type Tx } from "@repo/db";
import type * as z from "zod";
import { currentContext } from "./context";

/** Who and where, when the request context doesn't know (e.g. auth flows before a session exists). */
export interface EventOrigin {
  actorId?: string | null;
  orgId?: string | null;
}

export function createOutbox<C extends Record<string, z.ZodType>>(schema: string, catalog: C) {
  // The schema name is a constant chosen by the service, never input.
  const table = Prisma.raw(`"${schema}"."outbox_event"`);

  async function emitEvent<N extends keyof C & string>(
    tx: Tx,
    name: N,
    key: string,
    payload: z.infer<C[N]>,
    origin: EventOrigin = {},
  ) {
    const context = currentContext();
    const schemaFor = catalog[name];
    if (!schemaFor) {
      throw new Error(`Unknown event "${name}"`);
    }
    const data = JSON.stringify(schemaFor.parse(payload));
    // The organization: the one given (null included, for events that belong to none),
    // else the tenant this transaction runs as (tenantTx sets it, so a job, script or
    // seed gets it right with no request around), else the request's.
    const given = origin.orgId !== undefined;
    const orgId = given ? origin.orgId : (context?.orgId ?? null);
    const actorId = origin.actorId !== undefined ? origin.actorId : (context?.userId ?? null);
    await tx.$executeRaw`
      INSERT INTO ${table} (name, key, payload, org_id, actor_id, request_id)
      VALUES (${name}, ${key}, ${data}::jsonb,
        CASE WHEN ${given} THEN ${orgId}::uuid
             ELSE coalesce(nullif(current_setting('app.org_id', true), '')::uuid, ${orgId}::uuid) END,
        ${actorId}::uuid, ${context?.requestId ?? null})`;
    // Wakes the relay immediately (delivered on commit); it also polls as a safety net.
    await tx.$executeRaw`SELECT pg_notify('outbox', ${schema})`;
  }

  /** Any event with its matching payload, e.g. the result of a mapping function. */
  type AnyEvent = { [N in keyof C & string]: { name: N; payload: z.infer<C[N]> } }[keyof C &
    string];

  /**
   * emitEvent for an `AnyEvent`. TypeScript can't relate a union's `name` to its
   * `payload` through a generic call, so the pairing is asserted here, once; the catalog
   * still validates the payload at runtime.
   */
  function emitAnyEvent(tx: Tx, event: AnyEvent, key: string, origin: EventOrigin = {}) {
    return emitEvent(tx, event.name, key, event.payload as z.infer<C[typeof event.name]>, origin);
  }

  return { emitEvent, emitAnyEvent };
}

/** An `AnyEvent` for a catalog (see createOutbox). */
export type AnyEventOf<C extends Record<string, z.ZodType>> = {
  [N in keyof C & string]: { name: N; payload: z.infer<C[N]> };
}[keyof C & string];
