/**
 * Builds the API application: Nest modules, better-auth under /api/auth, and the oRPC
 * router under /rpc and /api/v1. main.ts starts it; integration tests build it in-process.
 */
import { HOUR_S } from "@repo/contracts/time";
import { loosely } from "@repo/i18n";
import {
  createRateLimiter,
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
import type { FastifyInstance } from "fastify";
import { Logger } from "nestjs-pino";
import * as z from "zod";
import { AppModule } from "./app.module";
import { AUTH, type Auth, MEMBERSHIPS, type Memberships } from "./auth/auth.module";
import { mountAuth } from "./auth/auth.routes";
import { env } from "./env";
import { mountMcp } from "./mcp";
import { ApiKeysService } from "./modules/api-keys";
import { DirectorService } from "./modules/director";
import { FilesService, mountFileContent } from "./modules/files";
import { createGoogleAuth, liveUpstream, mountLive } from "./modules/live";
import { mountOneClickUnsubscribe, NotificationsService } from "./modules/notifications";
import { TodoService } from "./modules/todo";
import { type AuthenticateApiKey, createProcedures, orgCallerFor } from "./rpc/procedures";
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
      const authenticateApiKey: AuthenticateApiKey = (key, scope) =>
        apiKeys.authenticate(key, scope);
      mountDirectorCall(fastify, {
        // Calls are for signed-in people: an API key is refused (no scope names a call).
        caller: orgCallerFor(auth, memberships, authenticateApiKey),
        director: app.get(DirectorService),
        redis: app.get<Redis>(REDIS),
        logger,
      });
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
          createProcedures(auth, memberships, authenticateApiKey, app.get<Redis>(REDIS)),
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

/** Director's live video call (/api/live), on when GOOGLE_CLOUD_PROJECT is set. */
function mountDirectorCall(
  fastify: FastifyInstance,
  deps: {
    caller: ReturnType<typeof orgCallerFor>;
    director: DirectorService;
    redis: Redis;
    logger: Logger;
  },
) {
  // Each call is minutes of Gemini audio and video: a few an hour is plenty to film a short.
  const calls = createRateLimiter(deps.redis, {
    name: "director-calls",
    points: 20,
    windowSeconds: HOUR_S,
    onRedisError: "deny",
  });
  mountLive(fastify, {
    allowedOrigins: [env.WEB_URL, ...env.APP_ORIGINS],
    caller: (headers) => deps.caller(headers, undefined),
    plan: (caller, videoId) => deps.director.plan(caller.userId, caller.orgId, videoId),
    spendCallLimit: async (userId) => {
      await calls.take(userId);
    },
    upstream: liveUpstream({
      project: env.GOOGLE_CLOUD_PROJECT,
      location: env.LIVE_LOCATION,
      model: env.LIVE_MODEL,
      auth: createGoogleAuth(env.GOOGLE_ACCESS_TOKEN),
    }),
    log: (level, details, message) => deps.logger[level](details, message),
    now: Date.now,
  });
}
