/**
 * The procedure builders every feature router uses. They implement the contract in
 * packages/contracts and add, in order:
 *
 *   base    error mapping (AppError → typed contract error) + client version gate
 *   authed  + a valid session (UNAUTHENTICATED otherwise); `context.user`, `context.session`
 *   inOrg   a signed-in member of the active organization; `context.orgId` (tenant for
 *           row-level security), `context.userId`, `context.role`
 *   inPrivateOrg
 *           + not the shared demo account (DEMO_ACCOUNT_LOCKED): for what's kept as the
 *           member's own (pictures, prompts, briefs, what Director remembers of them),
 *           which on an account everyone signs in to would be the next visitor's to see
 *
 *   export const directorRouter = ({ inOrg }: Procedures, director: DirectorService) => ({
 *     media: inOrg.director.media.handler(({ context }) => director.media(context.userId, ...)),
 *   });
 *
 * Every builder but `base` also applies the rate limit the procedure's contract declares
 * (`meta.rateLimit`, per user or per workspace), once it knows who's calling. Limits
 * outside the contract sit with what they protect: better-auth's for sign-in, and the
 * few a service keeps because other ways in share them.
 *
 * This is the only request pipeline for the API: Nest provides modules and dependency
 * injection, while auth, tenancy and error mapping live here, where they are typed and
 * apply identically to RPC and REST.
 */

import { implement, ORPCError, ValidationError } from "@orpc/server";
import {
  contract,
  type ErrorData,
  type ProcedureMeta,
  type RateLimit,
  rateLimitsOf,
} from "@repo/contracts/api";
import { ERROR_CODES, type ErrorCode, isErrorCode } from "@repo/contracts/errors";
import type { OrgId, UserId } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import type { OrgRole } from "@repo/contracts/roles";
import {
  AppError,
  createRateLimiter,
  currentContext,
  fromPrismaError,
  isAppError,
  type RateLimiter,
  type Redis,
  updateContext,
} from "@repo/nest-common";
import type { Auth } from "../auth/auth";
import { DEMO_EMAIL, visitorLimitKey } from "../auth/demo";
import { sessionWithIds } from "../auth/ids";
import type { Memberships } from "../auth/memberships";
import { env } from "../env";
import { actorContext } from "../http-context";

/** `instanceof ORPCError`, typed: the bare check narrows to ORPCError<any, any>. */
const isOrpcError = (error: unknown): error is ORPCError<string, unknown> =>
  error instanceof ORPCError;

export interface RpcContext {
  headers: Headers;
}

/** Who an organization-scoped call acts as. */
export interface OrgCaller {
  orgId: OrgId;
  userId: UserId;
  role: OrgRole;
  /** When the session signed in. */
  signedInAt: Date;
  /** The shared demo account, which may not publish (its user's `demo` flag). */
  demo: boolean;
  /** A demo guest (auth/guest.ts), which gets fewer live calls than a member. */
  guest: boolean;
  /**
   * The one demo account everyone signs in to (DEMO_EMAIL), as opposed to a private demo
   * guest of one browser's: what's recorded on it would be everyone's to see.
   */
  sharedDemo: boolean;
}

type ErrorParams = ErrorData["params"];

/** How a procedure's error is logged: "error" for our faults, "debug" for the client's. */
export type LogError = (error: unknown, level: "error" | "debug") => void;

/**
 * Maps anything thrown inside a procedure to the contract's error shape. An AppError of
 * 500 or more is our fault and is logged, cause and all (UPSTREAM_UNAVAILABLE wraps the
 * real failure); a 4xx is logged at debug when it carries a cause.
 */
export function toContractError(thrown: unknown, log: LogError): ORPCError<ErrorCode, unknown> {
  const requestId = currentContext()?.requestId;
  // A Prisma error a client can act on (a conflict, a row gone) becomes its catalog code.
  const error = fromPrismaError(thrown) ?? thrown;
  if (isAppError(error)) {
    if (error.status >= 500) {
      log(error, "error");
    } else if (error.cause !== undefined) {
      log(error, "debug");
    }
    return new ORPCError(error.code, {
      status: error.status,
      data: { params: error.params, requestId },
    });
  }
  if (isOrpcError(error)) {
    // Input validation failures carry the zod issues; send codes and paths, not English messages.
    if (error.code === "BAD_REQUEST" && error.cause instanceof ValidationError) {
      const issues = error.cause.issues.map((issue) => ({
        path: (issue.path ?? []).map(pathKey),
        code: "code" in issue && typeof issue.code === "string" ? issue.code : "invalid",
      }));
      return new ORPCError("VALIDATION_FAILED", {
        status: ERROR_CODES.VALIDATION_FAILED,
        data: { params: {} as ErrorParams, requestId, issues },
      });
    }
    if (isErrorCode(error.code)) {
      const data = (error.data ?? {}) as { params?: ErrorParams };
      return new ORPCError(error.code, {
        status: error.status,
        data: { params: data.params ?? {}, requestId },
      });
    }
  }
  log(error, "error");
  return new ORPCError("INTERNAL", { status: 500, data: { params: {} as ErrorParams, requestId } });
}

/** A validation path's segment as the contract sends it; JSON can't carry a symbol, so its name. */
function pathKey(segment: PropertyKey | { key: PropertyKey }): string | number {
  if (typeof segment === "object") {
    return String(segment.key);
  }
  return typeof segment === "symbol" ? String(segment) : segment;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

/**
 * Whether an app's version is below the minimum. Versions are major.minor.patch, and a
 * pre-release (1.2.0-beta) comes before its release. Anything else counts as older: a
 * gate that let unreadable versions through would let any client skip it.
 */
function isOlderVersion(version: string, minimum: string) {
  // The environment only accepts major.minor.patch for the minimum (src/env.ts).
  const [a, b] = [VERSION.exec(version), required(VERSION.exec(minimum), "a minimum version")];
  if (!a) {
    return true;
  }
  for (let i = 1; i <= 3; i++) {
    const diff = Number(a[i]) - Number(b[i]);
    if (diff !== 0) {
      return diff < 0;
    }
  }
  return a[4] !== undefined && b[4] === undefined;
}

/** Who a rate limit can be counted against: the caller, and their workspace if the call has one. */
export interface LimitKeys {
  user: string;
  org?: string;
}

/** The key a call spends its limit under. A per-workspace limit needs a workspace. */
export function rateLimitKey(limit: RateLimit, keys: LimitKeys) {
  const key = keys[limit.per];
  if (key === undefined) {
    throw new Error(`limit "${limit.name}" is per ${limit.per}, and the call has none`);
  }
  return key;
}

/**
 * Spends a call's rate limits, in the order declared (a demo guest's own ones too); one
 * limiter per name, so procedures sharing a name share it.
 */
function limitSpender(redis: Redis) {
  const limiters = new Map<string, RateLimiter>();
  return async (meta: ProcedureMeta, keys: LimitKeys, guest: boolean) => {
    for (const limit of rateLimitsOf(meta)) {
      if (limit.guestsOnly && !guest) {
        continue;
      }
      let limiter = limiters.get(limit.name);
      if (!limiter) {
        limiter = createRateLimiter(redis, limit);
        limiters.set(limit.name, limiter);
      }
      await limiter.take(rateLimitKey(limit, keys));
    }
  };
}

/** The request's session, if any, with its user's and workspace's ids branded. */
async function signedIn(auth: Auth, headers: Headers) {
  const result = await auth.api.getSession({ headers });
  return result && sessionWithIds(result);
}

/**
 * Who an organization-scoped call acts as: the signed-in person, in the session's active
 * organization, with their role there. Membership is re-checked every time, so someone
 * removed from it loses access immediately (see auth/memberships.ts).
 */
export function orgCallerFor(auth: Auth, memberships: Memberships) {
  return async (headers: Headers): Promise<OrgCaller> => {
    const result = await signedIn(auth, headers);
    if (!result) {
      throw new AppError("UNAUTHENTICATED");
    }
    updateContext({
      ...actorContext(result.user),
      locale: required(result.user.locale, "the locale"),
    });
    const orgId = result.session.activeOrganizationId;
    if (!orgId) {
      throw new AppError("NO_ACTIVE_ORGANIZATION");
    }
    const role = await memberships.role(orgId, result.user.id);
    if (!role) {
      throw new AppError("NO_ACTIVE_ORGANIZATION");
    }
    return {
      orgId,
      role,
      userId: result.user.id,
      signedInAt: new Date(result.session.createdAt),
      demo: result.user.demo === true,
      guest: result.user.guestUntil != null,
      sharedDemo: result.user.demo === true && result.user.email === DEMO_EMAIL,
    };
  };
}

export function createProcedures(auth: Auth, memberships: Memberships, redis: Redis) {
  const os = implement(contract).$context<RpcContext>();
  const spendLimit = limitSpender(redis);
  const orgCaller = orgCallerFor(auth, memberships);

  const base = os.use(async ({ next }) => {
    const version = currentContext()?.clientVersion;
    if (version && isOlderVersion(version, env.MINIMUM_CLIENT_VERSION)) {
      throw new AppError("CLIENT_OUTDATED", {
        params: { minimumVersion: env.MINIMUM_CLIENT_VERSION },
      });
    }
    return next();
  });

  const authed = base.use(
    async ({
      context,
      next,
      procedure: {
        "~orpc": { meta },
      },
    }) => {
      const result = await signedIn(auth, context.headers);
      if (!result) {
        throw new AppError("UNAUTHENTICATED");
      }
      // The column is NOT NULL; better-auth types optional fields as nullable.
      updateContext({
        ...actorContext(result.user),
        orgId: result.session.activeOrganizationId ?? undefined,
        locale: required(result.user.locale, "the locale"),
      });
      const sharedDemo = result.user.demo === true && result.user.email === DEMO_EMAIL;
      await spendLimit(
        meta,
        { user: visitorLimitKey(result.user.id, sharedDemo) },
        result.user.guestUntil != null,
      );
      return next({ context: { user: result.user, session: result.session } });
    },
  );

  const inOrg = base.use(
    async ({
      context,
      next,
      procedure: {
        "~orpc": { meta },
      },
    }) => {
      const caller = await orgCaller(context.headers);
      updateContext({ userId: caller.userId, orgId: caller.orgId });
      await spendLimit(
        meta,
        { user: visitorLimitKey(caller.userId, caller.sharedDemo), org: caller.orgId },
        caller.guest,
      );
      return next({ context: caller });
    },
  );

  const inPrivateOrg = inOrg.use(({ context, next }) => {
    if (context.sharedDemo) {
      throw new AppError("DEMO_ACCOUNT_LOCKED");
    }
    return next();
  });

  return { os, base, authed, inOrg, inPrivateOrg };
}

export type Procedures = ReturnType<typeof createProcedures>;
