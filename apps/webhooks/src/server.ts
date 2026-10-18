/**
 * Builds the webhooks service: health checks and the inbound provider routes. main.ts
 * starts it; integration tests build it in-process.
 */
import { createServer, DATABASE, type Database } from "@repo/nest-common";
import { AppModule } from "./app.module";
import { env } from "./env";
import { mountStalwart } from "./inbound/stalwart.routes";

export function createWebhooksServer() {
  return createServer(AppModule, {
    service: "webhooks",
    logLevel: env.LOG_LEVEL,
    trustedProxies: env.TRUSTED_PROXIES,
    loadShedding: env.LOAD_SHEDDING,
    corsOrigins: [],
    async configure(app) {
      const fastify = app.getHttpAdapter().getInstance();
      const database = app.get<Database>(DATABASE);
      mountStalwart(fastify, database, env.STALWART_WEBHOOK_SECRET);
    },
  });
}
