/** This service's transactional outbox (webhooks.outbox_event); see createOutbox in @repo/nest-common. */
import { events } from "@repo/contracts/events";
import { createOutbox } from "@repo/nest-common";

export const { emitEvent } = createOutbox("webhooks", events);
