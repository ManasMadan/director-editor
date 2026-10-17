/**
 * GET /api/live?videoId=…&shot=n, upgraded to a WebSocket: a voice and video call with
 * Director (Gemini Live on Vertex AI) about one shot of a short's plan. The browser
 * signs in with its session cookie and calls as its active workspace, exactly as an
 * `inOrg` procedure would; the call is refused (an `error` message, then the socket
 * closes) when the feature is off, the caller isn't signed in, the plan or shot doesn't
 * exist yet, or the caller already has a call open.
 *
 * Fastify's routing never sees an upgrade, so this listens on the Node server itself and
 * does its own auth and validation, like the other routes outside oRPC.
 */
import { STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import { DIRECTOR_MAX_SHOTS, type DirectorPlan, type ShotPlan } from "@repo/contracts/api";
import { type UserId, type VideoId, videoIdSchema } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import { MINUTE_MS, SECOND_MS } from "@repo/contracts/time";
import { AppError, describeError, isAppError } from "@repo/nest-common";
import type { FastifyInstance } from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import * as z from "zod";
import { toHeaders } from "../../http-context";
import type { OrgCaller } from "../../rpc/procedures";
import type { GoogleAuth } from "./google-auth";
import { CLIENT_MAX_PAYLOAD_BYTES } from "./live.messages";
import { closeWithError, type LiveLog, LiveRelay } from "./live.relay";
import { greetingMessage, type LiveModel, liveUrl, setupMessage } from "./live.setup";

export const LIVE_PATH = "/api/live";
/** A call's longest. Cost grows with every second of audio and video, and a shot is short. */
export const MAX_CALL_MS = 10 * MINUTE_MS;
const FRAME_INTERVAL_MS = SECOND_MS;

/** Where calls go, or null when the feature is off (GOOGLE_CLOUD_PROJECT unset). */
export interface LiveUpstream {
  model: LiveModel;
  url: string;
  auth: GoogleAuth;
}

export interface LiveOptions {
  /** Origins a browser may open a call from (a cross-site page carries the cookie too). */
  allowedOrigins: readonly string[];
  /** Who is calling, as `inOrg` resolves it; throws an AppError when no one may. */
  caller(headers: Headers): Promise<OrgCaller>;
  plan(caller: OrgCaller, videoId: VideoId): Promise<DirectorPlan>;
  /** Spends one of the caller's calls for the hour; throws RATE_LIMITED past it. */
  spendCallLimit(userId: UserId): Promise<void>;
  upstream: LiveUpstream | null;
  log: LiveLog;
  /** The clock camera frames are paced by (Date.now). */
  now: () => number;
}

/** The upstream for the environment's settings; null turns the feature off. */
export function liveUpstream(settings: {
  project: string | undefined;
  location: string;
  model: string;
  auth: GoogleAuth;
}): LiveUpstream | null {
  if (!settings.project) {
    return null;
  }
  return {
    model: { project: settings.project, location: settings.location, model: settings.model },
    url: liveUrl(settings.location),
    auth: settings.auth,
  };
}

const querySchema = z.object({
  videoId: videoIdSchema,
  shot: z.coerce
    .number()
    .int()
    .min(0)
    .max(DIRECTOR_MAX_SHOTS - 1),
});

/** The plan, once it's ready and has the shot. */
function readyPlan(plan: DirectorPlan, shot: number): ShotPlan {
  if (plan.status !== "ready" || !plan.plan) {
    throw new AppError("DIRECTOR_PLAN_NOT_FOUND");
  }
  if (shot >= plan.plan.shots.length) {
    throw new AppError("DIRECTOR_SHOT_NOT_FOUND");
  }
  return plan.plan;
}

/** Answers an upgrade that won't become a WebSocket with a plain HTTP status. */
function refuse(socket: Duplex, status: number) {
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`);
}

/** Tells the browser why its call couldn't start; our own failures are logged too. */
function refuseCall(log: LiveLog, client: WebSocket, error: unknown) {
  if (isAppError(error) && error.status < 500) {
    return closeWithError(client, error.code);
  }
  log("error", { err: describeError(error) }, "live call failed to start");
  closeWithError(client, isAppError(error) ? error.code : "INTERNAL");
}

function relayFor(
  client: WebSocket,
  upstream: LiveUpstream,
  call: { plan: ShotPlan; shot: number },
  options: LiveOptions,
) {
  return new LiveRelay(client, {
    url: upstream.url,
    auth: upstream.auth,
    setup: setupMessage(upstream.model, call.plan, call.shot),
    greeting: greetingMessage(call.shot),
    maxDurationMs: MAX_CALL_MS,
    frameIntervalMs: FRAME_INTERVAL_MS,
    now: options.now,
    log: options.log,
  });
}

export function mountLive(fastify: FastifyInstance, options: LiveOptions) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: CLIENT_MAX_PAYLOAD_BYTES });
  const allowedOrigins = new Set(options.allowedOrigins.map((url) => new URL(url).origin));
  // Users with a call open, in this process. Each replica keeps its own: with several,
  // a user could hold one call per replica, still each capped at MAX_CALL_MS.
  const calling = new Set<UserId>();

  async function call(client: WebSocket, headers: Headers, url: URL) {
    client.on("error", (error) =>
      options.log("warn", { err: describeError(error) }, "live client socket failed"),
    );
    let userId: UserId | null = null;
    try {
      const upstream = options.upstream;
      if (!upstream) {
        throw new AppError("FEATURE_DISABLED", { params: { feature: "live" } });
      }
      const query = querySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) {
        throw new AppError("VALIDATION_FAILED");
      }
      const caller = await options.caller(headers);
      if (calling.has(caller.userId)) {
        throw new AppError("CONFLICT");
      }
      calling.add(caller.userId);
      userId = caller.userId;
      await options.spendCallLimit(caller.userId);
      const plan = readyPlan(await options.plan(caller, query.data.videoId), query.data.shot);
      if (client.readyState !== WebSocket.OPEN) {
        return; // hung up while the plan loaded
      }
      await relayFor(client, upstream, { plan, shot: query.data.shot }, options).run();
    } catch (error) {
      refuseCall(options.log, client, error);
    } finally {
      if (userId) {
        calling.delete(userId);
      }
    }
  }

  fastify.server.on("upgrade", (request, socket, head) => {
    // Node always sets a server request's URL; only its typing allows none.
    const url = new URL(required(request.url, "the upgrade's URL"), "http://localhost");
    if (url.pathname !== LIVE_PATH) {
      return refuse(socket, 404);
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return refuse(socket, 403);
    }
    const headers = toHeaders(request);
    sockets.handleUpgrade(request, socket, head, (client) => void call(client, headers, url));
  });

  // Open calls would hold the server's close until they end; end them first.
  fastify.addHook("preClose", async () => {
    for (const client of sockets.clients) {
      client.terminate();
    }
  });
}
