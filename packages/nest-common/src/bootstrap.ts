/**
 * Starts a Nest service on Fastify with production defaults. Every service's
 * `main.ts` is a single call to this, so the behaviour below is identical everywhere.
 */
import "reflect-metadata";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { totalmem } from "node:os";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import underPressure from "@fastify/under-pressure";
import type { Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { createLogger, type LogLevel } from "@repo/logger";
import { Logger } from "nestjs-pino";
import { ContractExceptionFilter } from "./http-errors";
import { createRequestIdGenerator, REQUEST_ID_HEADER } from "./logging";
import { redactQuery } from "./telemetry";

export interface BootstrapOptions {
  port: number;
  /** Service name on every log line (matches LoggerModule's `service`). */
  service: string;
  logLevel?: LogLevel;
  /** Peers allowed to set X-Forwarded-For / x-request-id (see `coreEnv.TRUSTED_PROXIES`). */
  trustedProxies: string[];
  /** Browser origins allowed to call this service with credentials. Omit for internal services. */
  corsOrigins?: string[];
  /** Answer 503 when saturated (see below); on unless `coreEnv.LOAD_SHEDDING` is off. */
  loadShedding?: boolean;
  /** Runs after plugins are registered and before `listen`, e.g. to mount non-Nest routes. */
  configure?: (app: NestFastifyApplication) => Promise<void> | void;
}

/** Security headers, load shedding and CORS. */
async function registerProtections(
  app: NestFastifyApplication,
  options: Omit<BootstrapOptions, "port">,
) {
  await app.register(helmet, {
    // JSON API: no HTML is served, so a locked-down CSP costs nothing.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
  });
  // Shed load instead of queueing it: when the event loop or heap is saturated, answer
  // 503 immediately (the load balancer retries elsewhere) rather than letting every
  // request time out. Readiness fails too, so Kubernetes stops routing here.
  if (options.loadShedding !== false) {
    await app.register(underPressure, {
      // Shed load (503 + Retry-After) only when the process is really saturated: event
      // loop utilisation is sustained busyness; a single slow tick (GC, the OS briefly
      // scheduling other work) isn't. Delay is the backstop for a truly stuck loop.
      maxEventLoopUtilization: 0.98,
      maxEventLoopDelay: 3_000,
      maxHeapUsedBytes: maxHeapBytes(),
      retryAfter: 5,
      exposeStatusRoute: false,
    });
  }

  if (options.corsOrigins?.length) {
    await app.register(cors, {
      origin: options.corsOrigins,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      // Lets the browser read the request id (for error screens and support tickets).
      exposedHeaders: [REQUEST_ID_HEADER],
      maxAge: 600,
    });
  }
}

/**
 * One line per completed request, with the final status Fastify sent, and the request id
 * echoed back.
 */
function logRequests(app: NestFastifyApplication, options: Omit<BootstrapOptions, "port">) {
  // One line per completed request, with the final status Fastify sent. Health probes
  // run every few seconds and are skipped. Keys are flat on purpose: pino applies its
  // request/response serializers to any `req`/`res` key.
  const requestLog = createLogger({ service: options.service, level: options.logLevel });
  app
    .getHttpAdapter()
    .getInstance()
    .addHook("onResponse", async (request, reply) => {
      if (request.url.startsWith("/health")) {
        return;
      }
      const status = reply.statusCode;
      const line = {
        requestId: request.id,
        method: request.method,
        url: redactQuery(request.url),
        status,
        durationMs: Math.round(reply.elapsedTime),
      };
      if (status >= 500) {
        requestLog.error(line, "request completed");
      } else if (status >= 400) {
        requestLog.warn(line, "request completed");
      } else {
        requestLog.info(line, "request completed");
      }
    });

  // Echo the id so clients and upstream proxies can correlate their logs with ours.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook("onRequest", async (request, reply) => {
      reply.header(REQUEST_ID_HEADER, request.id);
    });
}

/**
 * Hangs up, at shutdown, on connections that haven't sent a request. Node's server.close()
 * ends idle keep-alive connections but waits for one that never sent anything (a
 * browser's preconnect, or an HTTP client reconnecting for a request it then dropped)
 * until headersTimeout reaps it, a minute or more later, and shutdown waits with it.
 */
function closeUnusedConnections(app: NestFastifyApplication) {
  const fastify = app.getHttpAdapter().getInstance();
  const unused = new Set<Socket>();
  fastify.server.on("connection", (socket: Socket) => {
    unused.add(socket);
    socket.once("close", () => unused.delete(socket));
  });
  fastify.server.on("request", (request: IncomingMessage) => unused.delete(request.socket));
  fastify.addHook("preClose", async () => {
    for (const socket of unused) {
      socket.destroy();
    }
  });
}

/**
 * The heap size past which a service sheds load: 90% of its container's memory limit, or
 * of 2 GB where it runs without one. Without a limit, `constrainedMemory` reports 0 on some
 * platforms and a cgroup's "max" (about 2^64) on Linux, so a limit above the machine's
 * memory counts as none.
 */
export function maxHeapBytes(constrained = process.constrainedMemory?.(), machine = totalmem()) {
  return 0.9 * (constrained && constrained <= machine ? constrained : 2 * 1024 ** 3);
}

/** Builds and configures the application without listening (used by tests and bootstrap). */
export async function createServer(
  module: Type<unknown>,
  options: Omit<BootstrapOptions, "port">,
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    // Behind a load balancer the client IP arrives in X-Forwarded-For. Only trusted
    // proxies may set it, otherwise any caller could forge the IP that rate limiting,
    // lockout and audit logs rely on.
    trustProxy: options.trustedProxies,
    // Uploads go straight to object storage via presigned URLs; request bodies stay small.
    bodyLimit: 1024 * 1024,
    // Our pino logger (nestjs-pino) logs requests; Fastify's own logger would duplicate it.
    logger: false,
    // One id per request, reused by the logger (see createRequestIdGenerator).
    requestIdHeader: false,
    genReqId: createRequestIdGenerator(options.trustedProxies),
  });

  const app = await NestFactory.create<NestFastifyApplication>(module, adapter, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  // Every error Nest handles (its routes, its 404, body parsing and load shedding, which
  // Fastify hands to Nest) answers in the contract's shape.
  app.useGlobalFilters(new ContractExceptionFilter());

  await registerProtections(app, options);
  logRequests(app, options);

  // SIGTERM (Kubernetes) → stop accepting connections, finish in-flight requests, run
  // every provider's onApplicationShutdown (close DB/Redis/queues), then exit.
  app.enableShutdownHooks();
  closeUnusedConnections(app);

  await options.configure?.(app);
  return app;
}

/** Builds the application and starts listening on all interfaces. */
export async function bootstrap(
  module: Type<unknown>,
  options: BootstrapOptions,
): Promise<NestFastifyApplication> {
  const app = await createServer(module, options);
  await app.listen({ port: options.port, host: "0.0.0.0" });
  return app;
}
