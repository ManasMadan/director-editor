import { env } from "./env";
import { createWebhooksServer } from "./server";

/** The running service (exported for the test that starts it). */
export const app = await createWebhooksServer();
await app.listen({ port: env.PORT, host: "0.0.0.0" });
