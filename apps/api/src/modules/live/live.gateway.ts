/**
 * GET /api/live?videoId=…&shot=n, upgraded to a WebSocket: Director live (Gemini Live on
 * Vertex AI) for a shoot of a short's plan, starting on shot n and following the browser
 * from shot to shot; `&resume=1` when the browser lost Director a moment ago and came
 * straight back, so Director doesn't say hello twice. The browser signs in with its
 * session cookie and connects as its active workspace, exactly as an `inOrg` procedure
 * would; it's refused (an `error` message, then the socket closes) when the feature is
 * off, the caller isn't signed in, the plan or shot doesn't exist yet, or the caller
 * already has Director live open elsewhere.
 *
 * Fastify's routing never sees an upgrade, so this listens on the Node server itself and
 * does its own auth and validation, like the other routes outside oRPC.
 */
import { AsyncResource } from "node:async_hooks";
import { type IncomingMessage, STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import type { ActivityName } from "@repo/contracts/activity";
import { DIRECTOR_MAX_SHOTS, type DirectorPlan, type ShotPlan } from "@repo/contracts/api";
import { type UserId, type VideoId, videoIdSchema } from "@repo/contracts/ids";
import { LIVE_PATH } from "@repo/contracts/live";
import { required } from "@repo/contracts/objects";
import { MINUTE_MS, SECOND_MS } from "@repo/contracts/time";
import {
  type Activity,
  type ActivityTarget,
  AppError,
  describeError,
  isAppError,
  outcomeOf,
  type RequestContext,
  runWithContext,
  updateContext,
} from "@repo/nest-common";
import type { FastifyInstance } from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import * as z from "zod";
import type { RecordActivity } from "../../activity";
import { toHeaders } from "../../http-context";
import type { OrgCaller } from "../../rpc/procedures";
import type { GoogleAuth } from "./google-auth";
import { CLIENT_MAX_PAYLOAD_BYTES } from "./live.messages";
import type { LivePicks } from "./live.picks";
import { type CallEnd, closeWithError, type LiveLog, LiveRelay } from "./live.relay";
import { type LiveModel, liveUrl, setupMessage } from "./live.setup";

/**
 * A shoot's longest with Director live. Cost grows with every second of audio and video,
 * and half an hour is time enough to film a whole short; past it the member brings
 * Director back with a tap (another of the hour's allowance).
 */
export const MAX_LIVE_MS = 30 * MINUTE_MS;
/**
 * How long one connection to Gemini is used. The Live API closes a connection after about
 * ten minutes (warning first with goAway): the relay moves to a fresh one a little
 * before, carrying the conversation over, so the member never notices.
 */
export const ROTATE_AFTER_MS = 9 * MINUTE_MS;
const FRAME_INTERVAL_MS = SECOND_MS;

/** Where Director live goes, or null when the feature is off (GOOGLE_CLOUD_PROJECT unset). */
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
  /**
   * Where the member's "use the second one" goes: their takes of the short since the
   * shoot began (`since`), numbered per shot in the order filmed.
   */
  picks(caller: OrgCaller, videoId: VideoId, since: Date): LivePicks;
  /**
   * Spends one of the caller's connections for the hour (a demo guest's against its own,
   * smaller limit); throws RATE_LIMITED past it.
   */
  spendCallLimit(caller: Pick<OrgCaller, "userId" | "guest">): Promise<void>;
  upstream: LiveUpstream | null;
  /**
   * Whether Live is off for this member alone (LIVE_OFF_USERS): refused as if off, so the
   * shoot screen moves to the slower line.
   */
  liveOff(userId: UserId): boolean;
  log: LiveLog;
  /** The clock camera frames are paced by (Date.now). */
  now: () => number;
  /** Records that Director live reached Gemini and started (fire-and-forget analytics). */
  recordCallStarted(userId: UserId, videoId: VideoId): void;
  /** The upgrade's request context: its id, address and user agent (http-context.ts). */
  context(request: IncomingMessage): RequestContext;
  /** Writes the call's activity lines: started (or refused), and how it ended. */
  activity: RecordActivity;
}

/**
 * The upstream for the environment's settings; null turns the feature off. `url` is the
 * tests' stand-in (LIVE_API_URL); unset, it's the region's own endpoint.
 */
export function liveUpstream(settings: {
  project: string | undefined;
  location: string;
  model: string;
  url?: string | undefined;
  auth: GoogleAuth;
}): LiveUpstream | null {
  if (!settings.project) {
    return null;
  }
  return {
    model: { project: settings.project, location: settings.location, model: settings.model },
    url: settings.url ?? liveUrl(settings.location),
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
  resume: z.literal("1").optional(),
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

/** Answers an upgrade that won't become a WebSocket with a plain HTTP status, and hangs up. */
function refuse(socket: Duplex, status: number) {
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`, () =>
    socket.destroy(),
  );
}

function isLiveUpgrade(request: IncomingMessage) {
  // Node always sets a server request's URL; only its typing allows none.
  return (
    new URL(required(request.url, "the upgrade's URL"), "http://localhost").pathname === LIVE_PATH
  );
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
  call: { plan: ShotPlan; shot: number; resumed: boolean; caller: OrgCaller; videoId: VideoId },
  options: LiveOptions,
) {
  return new LiveRelay(client, {
    url: upstream.url,
    auth: upstream.auth,
    setup: (shot, handle, version) =>
      setupMessage(upstream.model, call.plan, shot, { handle, version }),
    plan: call.plan,
    shot: call.shot,
    resumed: call.resumed,
    maxDurationMs: MAX_LIVE_MS,
    rotateAfterMs: ROTATE_AFTER_MS,
    frameIntervalMs: FRAME_INTERVAL_MS,
    now: options.now,
    log: options.log,
    // Called from Gemini's socket, outside the call's request context: bound back to it,
    // so the line names the caller and the request.
    picks: options.picks(call.caller, call.videoId, new Date(options.now())),
    onCallStarted: AsyncResource.bind(() => {
      options.recordCallStarted(call.caller.userId, call.videoId);
      options.activity({ activity: "director.call_started", target: callTarget(call) });
    }),
  });
}

/** What a call's activity lines are about: its short and the shot it opened on. */
function callTarget(call: { videoId: VideoId; shot: number }): ActivityTarget {
  return { videoId: call.videoId, shot: call.shot };
}

/**
 * How a call ended, as an activity line: ok when the browser hung up or the call ran its
 * time, refused or failed by its code otherwise, and how long it lasted once it started.
 */
export function callEnded(
  { code, startedAt }: CallEnd,
  target: ActivityTarget,
  now: number,
): Activity<ActivityName> {
  const ok = code === null || code === "TIMEOUT";
  return {
    activity: "director.call_ended",
    outcome: ok ? "ok" : outcomeOf({ code }).outcome,
    reason: code ?? "HUNG_UP",
    target: { ...target, started: startedAt !== null },
    durationMs: startedAt === null ? undefined : now - startedAt,
  };
}

/**
 * Node hands every upgrade to an "upgrade" listener once there is one; this keeps the
 * others (an h2c upgrade to /rpc, say) on Fastify's routing as ordinary requests.
 */
function registerUpgrade(
  fastify: FastifyInstance,
  sockets: WebSocketServer,
  allowedOrigins: ReadonlySet<string>,
  options: Pick<LiveOptions, "log" | "context">,
  call: (client: WebSocket, headers: Headers, url: URL) => Promise<void>,
) {
  Object.assign(fastify.server, { shouldUpgradeCallback: isLiveUpgrade });
  fastify.server.on("upgrade", (request, socket, head) => {
    // Node takes its own error handler off a socket it hands over: without one, a client
    // resetting the connection would crash the process. ws adds its own once it upgrades.
    const onError = (error: Error) =>
      options.log("warn", { err: describeError(error) }, "live upgrade socket failed");
    socket.on("error", onError);
    // Only a Node without shouldUpgradeCallback (older than 24.9) sends any other path here.
    if (!isLiveUpgrade(request)) {
      return refuse(socket, 404);
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return refuse(socket, 403);
    }
    const url = new URL(required(request.url, "the upgrade's URL"), "http://localhost");
    const headers = toHeaders(request);
    sockets.handleUpgrade(request, socket, head, (client) => {
      socket.off("error", onError);
      // Its own request context, like any request: the call's lines carry its id.
      void runWithContext(options.context(request), () => call(client, headers, url));
    });
  });
}

export function mountLive(fastify: FastifyInstance, options: LiveOptions) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: CLIENT_MAX_PAYLOAD_BYTES });
  const allowedOrigins = new Set(options.allowedOrigins.map((url) => new URL(url).origin));
  // Users with Director live open, in this process. Each replica keeps its own: with
  // several, a user could hold one per replica, still each capped at MAX_LIVE_MS.
  const calling = new Set<UserId>();

  async function call(client: WebSocket, headers: Headers, url: URL) {
    client.on("error", (error) =>
      options.log("warn", { err: describeError(error) }, "live client socket failed"),
    );
    let userId: UserId | null = null;
    // What the call is about, for its activity lines, once its query is known to be valid.
    let target: ActivityTarget = {};
    try {
      const upstream = options.upstream;
      if (!upstream) {
        throw new AppError("FEATURE_DISABLED", { params: { feature: "live" } });
      }
      const query = querySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) {
        throw new AppError("VALIDATION_FAILED");
      }
      target = callTarget(query.data);
      const caller = await options.caller(headers);
      updateContext({ orgId: caller.orgId });
      if (options.liveOff(caller.userId)) {
        throw new AppError("FEATURE_DISABLED", { params: { feature: "live" } });
      }
      if (calling.has(caller.userId)) {
        throw new AppError("CONFLICT");
      }
      calling.add(caller.userId);
      userId = caller.userId;
      const plan = readyPlan(await options.plan(caller, query.data.videoId), query.data.shot);
      // Only a call that can really start is charged.
      await options.spendCallLimit(caller);
      if (client.readyState !== WebSocket.OPEN) {
        // Hung up while the plan loaded: a call that ended before it began.
        options.activity(callEnded({ code: null, startedAt: null }, target, options.now()));
        return;
      }
      const ended = await relayFor(
        client,
        upstream,
        {
          plan,
          shot: query.data.shot,
          resumed: query.data.resume === "1",
          caller,
          videoId: query.data.videoId,
        },
        options,
      ).run();
      options.activity(callEnded(ended, target, options.now()));
    } catch (error) {
      options.activity({ activity: "director.call_started", ...outcomeOf(error), target });
      refuseCall(options.log, client, error);
    } finally {
      if (userId) {
        calling.delete(userId);
      }
    }
  }

  registerUpgrade(fastify, sockets, allowedOrigins, options, call);

  // Open sockets would hold the server's close until they end; end them first.
  fastify.addHook("preClose", async () => {
    for (const client of sockets.clients) {
      client.terminate();
    }
  });
}
