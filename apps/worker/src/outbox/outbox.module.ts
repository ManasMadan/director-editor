import { Module } from "@nestjs/common";
import { BullMqEventBus, EventBus } from "./event-bus";
import { OutboxRelay } from "./relay.service";

@Module({
  providers: [
    // The EventBus seam: bind another implementation here to change the transport.
    { provide: EventBus, useClass: BullMqEventBus },
    OutboxRelay,
  ],
  exports: [OutboxRelay],
})
export class OutboxModule {}
