/**
 * Builds the API application: Nest modules, better-auth under /api/auth, and the oRPC
 * router under /rpc and /api/v1. main.ts starts it; integration tests build it in-process.
 */
import { HOUR_S } from "@repo/contracts/time";
import {
  createRateLimiter,
  createServer,
  describeError,
  REDIS,
  type Redis,
} from "@repo/nest-common";
import type { FastifyInstance } from "fastify";
import { Logger } from "nestjs-pino";
import { ACTIVITY, type RecordActivity } from "./activity";
import { AppModule } from "./app.module";
import { AUTH, type Auth, MEMBERSHIPS, type Memberships } from "./auth/auth.module";
import { mountAuth } from "./auth/auth.routes";
import { env } from "./env";
import { upgradeContext } from "./http-context";
import { AnalyticsService } from "./modules/analytics";
import { DirectorService } from "./modules/director";
import { FilesService, mountFileContent } from "./modules/files";
import { createGoogleAuth, type LiveOptions, liveUpstream, mountLive } from "./modules/live";
import { createProcedures, orgCallerFor } from "./rpc/procedures";
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
      const recordActivity = app.get<RecordActivity>(ACTIVITY);
      mountAuth(fastify, auth, env.BETTER_AUTH_URL, recordActivity);
      mountFileContent(fastify, auth, app.get(FilesService));
      mountDirectorCall(fastify, {
        caller: orgCallerFor(auth, memberships),
        director: app.get(DirectorService),
        analytics: app.get(AnalyticsService),
        redis: app.get<Redis>(REDIS),
        logger,
        activity: recordActivity,
      });
      await mountRpc(
        fastify,
        createRouter(createProcedures(auth, memberships, app.get<Redis>(REDIS)), app),
        {
          logError: (error, level) =>
            logger[level]({ err: describeError(error) }, "error in procedure"),
          recordActivity,
          publicUrl: env.BETTER_AUTH_URL,
          release: env.RELEASE,
          exposeDocs: env.NODE_ENV !== "production",
          strictErrors: env.NODE_ENV !== "production",
        },
      );
    },
  });
}

/**
 * The live call's wiring to the rest of the API, kept apart from mounting it
 * (mountDirectorCall) so a test can call each option directly without opening a real
 * socket to Gemini.
 */
export function liveCallOptions(deps: {
  caller: ReturnType<typeof orgCallerFor>;
  director: Pick<DirectorService, "planOf">;
  analytics: Pick<AnalyticsService, "record">;
  // Only the one method this needs, so a test gives a plain stand-in, not a real limiter.
  calls: { take(userId: string): Promise<void> };
  logger: Pick<Logger, "warn" | "error">;
  activity: RecordActivity;
}): LiveOptions {
  return {
    allowedOrigins: [env.WEB_URL],
    caller: deps.caller,
    plan: (caller, videoId) => deps.director.planOf(caller.userId, caller.orgId, videoId),
    spendCallLimit: async (userId) => {
      await deps.calls.take(userId);
    },
    upstream: liveUpstream({
      project: env.GOOGLE_CLOUD_PROJECT,
      location: env.LIVE_LOCATION,
      model: env.LIVE_MODEL,
      auth: createGoogleAuth(env.GOOGLE_ACCESS_TOKEN),
    }),
    log: (level, details, message) => deps.logger[level](details, message),
    now: Date.now,
    recordCallStarted: (userId, videoId) =>
      deps.analytics.record("call_started", { userId, videoId }),
    context: upgradeContext(env.TRUSTED_PROXIES),
    activity: deps.activity,
  };
}

/** Director's live video call (/api/live), on when GOOGLE_CLOUD_PROJECT is set. */
function mountDirectorCall(
  fastify: FastifyInstance,
  deps: {
    caller: ReturnType<typeof orgCallerFor>;
    director: DirectorService;
    analytics: AnalyticsService;
    redis: Redis;
    logger: Logger;
    activity: RecordActivity;
  },
) {
  // Each call is minutes of Gemini audio and video: a few an hour is plenty to film a short.
  const calls = createRateLimiter(deps.redis, {
    name: "director-calls",
    points: 20,
    windowSeconds: HOUR_S,
    onRedisError: "deny",
  });
  mountLive(fastify, liveCallOptions({ ...deps, calls }));
}
