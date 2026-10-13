/**
 * Builds the API application: Nest modules, better-auth under /api/auth, and the oRPC
 * router under /rpc and /api/v1. main.ts starts it; integration tests build it in-process.
 */
import { loosely } from "@repo/i18n";
import {
  createServer,
  DATABASE,
  type Database,
  describeError,
  I18N,
  type I18n,
  REDIS,
  type Redis,
  row,
} from "@repo/nest-common";
import { Logger } from "nestjs-pino";
import * as z from "zod";
import { AppModule } from "./app.module";
import { AUTH, type Auth, MEMBERSHIPS, type Memberships } from "./auth/auth.module";
import { mountAuth } from "./auth/auth.routes";
import { env } from "./env";
import { mountMcp } from "./mcp";
import { ApiKeysService } from "./modules/api-keys";
import { FilesService, mountFileContent } from "./modules/files";
import { mountOneClickUnsubscribe, NotificationsService } from "./modules/notifications";
import { TodoService } from "./modules/todo";
import { createProcedures } from "./rpc/procedures";
import { createRouter } from "./rpc/router";
import { mountRpc } from "./rpc/rpc.routes";

export function createApiServer() {
  return createServer(AppModule, {
    service: "api",
    logLevel: env.LOG_LEVEL,
    trustedProxies: env.TRUSTED_PROXIES,
    loadShedding: env.LOAD_SHEDDING,
    corsOrigins: [env.WEB_URL],
    async configure(app) {
      const fastify = app.getHttpAdapter().getInstance();
      const auth = app.get<Auth>(AUTH);
      const memberships = app.get<Memberships>(MEMBERSHIPS);
      const logger = app.get(Logger);
      mountAuth(fastify, auth, env.BETTER_AUTH_URL);
      mountOneClickUnsubscribe(fastify, app.get(NotificationsService));
      mountFileContent(fastify, auth, app.get(FilesService));
      const database = app.get<Database>(DATABASE);
      const i18n = app.get<I18n>(I18N);
      const apiKeys = app.get(ApiKeysService);
      mountMcp(fastify, {
        siteUrl: env.BETTER_AUTH_URL,
        keys: () => auth.api.getJwks(),
        // On the primary: a disconnect must be seen by the very next request.
        grantActive: async (clientId, userId, orgId) => {
          const { active } = await row(
            z.object({ active: z.boolean() }),
            database.write.$queryRaw`
              SELECT auth.mcp_grant_active(${clientId}, ${userId}::uuid, ${orgId}::uuid) AS active`,
          );
          return active;
        },
        redis: app.get<Redis>(REDIS),
        server: {
          todos: app.get(TodoService),
          release: env.RELEASE,
          logError: (error) => logger.error({ err: describeError(error) }, "MCP tool failed"),
        },
        describeError: async (error, locale) => {
          const t = loosely(await i18n.getTranslator(locale));
          return t(`errors.${error.code}`, error.params);
        },
      });
      await mountRpc(
        fastify,
        createRouter(
          createProcedures(
            auth,
            memberships,
            (key, scope) => apiKeys.authenticate(key, scope),
            app.get<Redis>(REDIS),
          ),
          app,
        ),
        {
          logError: (error, level) =>
            logger[level]({ err: describeError(error) }, "error in procedure"),
          publicUrl: env.BETTER_AUTH_URL,
          release: env.RELEASE,
          exposeDocs: env.NODE_ENV !== "production",
          strictErrors: env.NODE_ENV !== "production",
        },
      );
    },
  });
}
