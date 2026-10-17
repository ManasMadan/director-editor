/**
 * This service's transactional outbox (app.outbox_event); see createOutbox in
 * @repo/nest-common for how and why.
 *
 *   await transaction(database.write, async (tx) => {
 *     await tx.user.update(...);
 *     await emitEvent(tx, "auth.password_changed.v1", userId, { userId });
 *   });
 */
import { events } from "@repo/contracts/events";
import { type AnyEventOf, createOutbox } from "@repo/nest-common";

export type { EventOrigin } from "@repo/nest-common";
export type AnyEvent = AnyEventOf<typeof events>;
export const { emitEvent, emitAnyEvent } = createOutbox("app", events);
