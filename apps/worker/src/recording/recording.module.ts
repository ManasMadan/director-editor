import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { createAiClient } from "@repo/ai-client";
import { MINUTE_MS } from "@repo/contracts/time";
import { queuePrefix } from "@repo/jobs";
import { createStorage, STORAGE } from "@repo/nest-common";
import { env } from "../env";
import { AI_CLIENT, ClipProcessor } from "./clip.processor";

// As long as the AI service may take to answer: the Cloud Run clipper's own timeout
// (15 minutes, docs/deploy.md), and a little more for the hop to it.
const CLIP_TIMEOUT_MS = 16 * MINUTE_MS;

/** The AI service's client, when the worker has it (AI_URL and AI_SERVICE_SECRET). */
export function createClipClient() {
  if (Boolean(env.AI_URL) !== Boolean(env.AI_SERVICE_SECRET)) {
    throw new Error("AI_URL and AI_SERVICE_SECRET go together: set both, or neither");
  }
  return env.AI_URL && env.AI_SERVICE_SECRET
    ? createAiClient({
        baseUrl: env.AI_URL,
        secret: env.AI_SERVICE_SECRET,
        timeoutMs: CLIP_TIMEOUT_MS,
      })
    : null;
}

@Module({
  imports: [BullModule.registerQueue({ name: "recording", prefix: queuePrefix("recording") })],
  providers: [
    { provide: STORAGE, useFactory: () => createStorage(env) },
    { provide: AI_CLIENT, useFactory: createClipClient },
    ClipProcessor,
  ],
  exports: [ClipProcessor],
})
export class RecordingModule {}
