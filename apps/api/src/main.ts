import { env } from "./env";
import { createApiServer } from "./server";

export const app = await createApiServer();
await app.listen({ port: env.PORT, host: "0.0.0.0" });
