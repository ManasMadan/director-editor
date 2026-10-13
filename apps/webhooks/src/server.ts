/**
 * Builds the webhooks service: health checks, inbound provider routes, and the delivery
 * workers (registered by the modules). main.ts starts it; integration tests build it
 * in-process.
 */
import { createServer, DATABASE, type Database } from "@repo/nest-common";
import { AppModule } from "./app.module";
import { env } from "./env";
import { mountStalwart } from "./inbound/stalwart.routes";
import { mountStripe } from "./inbound/stripe.routes";

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
      mountStripe(fastify, database, env.STRIPE_WEBHOOK_SECRET);
      mountStalwart(fastify, database, env.STALWART_WEBHOOK_SECRET);
    },
  });
}
