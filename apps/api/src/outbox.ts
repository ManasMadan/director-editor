/**
 * This service's transactional outbox (app.outbox_event); see createOutbox in
 * @repo/nest-common for how and why.
 *
 *   await tenantTx(database.write, orgId, async (tx) => {
 *     const todo = await tx.todo.update(...);
 *     await emitEvent(tx, "todo.completed.v1", todo.id, { todoId: todo.id, title: todo.title });
 *   });
 */
import { events } from "@repo/contracts/events";
import { type AnyEventOf, createOutbox } from "@repo/nest-common";

export type { EventOrigin } from "@repo/nest-common";
export type AnyEvent = AnyEventOf<typeof events>;
export const { emitEvent, emitAnyEvent } = createOutbox("app", events);
