import { bootstrap } from "@repo/nest-common";
import { AppModule } from "./app.module";
import { env } from "./env";

/** The running service (exported for the test that starts it). */
export const app = await bootstrap(AppModule, {
  port: env.PORT,
  service: "worker",
  logLevel: env.LOG_LEVEL,
  trustedProxies: env.TRUSTED_PROXIES,
  loadShedding: env.LOAD_SHEDDING,
});
