/** Realtime messages for this service (see createRealtime in @repo/nest-common). */
import { realtimeMessage } from "@repo/contracts/realtime";
import { createRealtime } from "@repo/nest-common";

export const { publish: publishRealtime, RealtimeHub } = createRealtime(realtimeMessage);
