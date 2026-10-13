/**
 * The base every procedure is built from. It declares the error codes any call can fail
 * with (COMMON_ERRORS: authentication, validation, limits, the server refusing the
 * request); each contract module adds the codes its own procedures throw with
 * `.errors(errorsOf(...))`. So a client gets the union of codes a call can fail with
 * (`isDefinedError(error) && error.code === "TODO_NOT_FOUND"`), the OpenAPI document
 * lists only those per operation, and every surface returns the same structure. The API
 * refuses, outside production, to answer a code a procedure didn't declare.
 * Procedures also carry metadata (ProcedureMeta): which API key scope lets a key call
 * them (see ./scopes.ts), and the rate limit the API applies to each call.
 */
import { oc } from "@orpc/contract";
import * as z from "zod";
import { ERROR_CODES, type ErrorCode, errorCode } from "../errors";
import type { ApiKeyScope } from "./scopes";

/** One field's problem in a VALIDATION_FAILED error: where, and a code the client translates. */
export const errorIssue = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  code: z.string(),
});

export const errorData = z.object({
  /**
   * Values the client needs to render the translated message. Strings and numbers only:
   * they're ICU message arguments (use `{flag, select, yes {…} other {…}}` for choices).
   */
  params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  /** Correlates the error with server logs; show it on error screens. */
  requestId: z.string().optional(),
  /** Per-field problems for VALIDATION_FAILED: path + code, translated client-side. */
  issues: z.array(errorIssue).optional(),
});
export type ErrorData = z.infer<typeof errorData>;

/**
 * The body of every error response, as oRPC serializes a contract error
 * (`ORPCError.toJSON()`). The Python service answers with exactly this shape too: its
 * model is generated from this schema.
 */
export const errorResponse = z.object({
  defined: z.boolean(),
  code: errorCode,
  status: z.number().int(),
  /** For logs only: clients translate `code`. */
  message: z.string(),
  data: errorData,
});

/** The oRPC error map for these codes, with their catalog statuses and the one data shape. */
export function errorsOf<C extends ErrorCode>(...codes: C[]) {
  // TypeScript can't type an object built from a list of keys (Object.fromEntries gives a
  // string record), and clients need each code's own entry to type its error.
  // type-coverage:ignore-next-line
  return Object.fromEntries(
    codes.map((code) => [code, { status: ERROR_CODES[code], data: errorData }]),
  ) as { [K in C]: { status: (typeof ERROR_CODES)[K]; data: typeof errorData } };
}

/** What any call can fail with, whatever it does. */
export const COMMON_ERRORS = [
  "BAD_REQUEST",
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "INTERNAL",
  "SERVICE_UNAVAILABLE",
  "CLIENT_OUTDATED",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "METHOD_NOT_SUPPORTED",
  "TIMEOUT",
] as const satisfies readonly ErrorCode[];

/**
 * What a call in a workspace adds: none active. A module with procedures API keys may
 * call adds API_KEY_SCOPE_MISSING too, for a key without the scope.
 */
export const WORKSPACE_ERRORS = ["NO_ACTIVE_ORGANIZATION"] as const satisfies readonly ErrorCode[];

/**
 * A limit on how often a procedure may be called, applied by the API's request pipeline
 * once it knows who's calling (RATE_LIMITED with `retryAfterSeconds` past it).
 */
export interface RateLimit {
  /** Names its counters in Redis: procedures that share a name share one allowance. */
  name: string;
  points: number;
  windowSeconds: number;
  /** Whose allowance a call spends: the caller's, or their workspace's (whoever calls). */
  per: "user" | "org";
  /**
   * When Redis is down: "deny" (the default) for anything that costs money, sends
   * messages or calls out; "allow" for everyday changes, so an outage doesn't stop them.
   */
  onRedisError?: "deny" | "allow";
}

/** Metadata every procedure can carry (read by the API's request pipeline). */
export interface ProcedureMeta {
  /** Lets API keys with this scope call the procedure. */
  apiKeyScope?: ApiKeyScope;
  /**
   * The procedure's rate limit, or why it has none. Every procedure that changes
   * something (any method but GET) needs one or the other; a test checks it.
   */
  rateLimit?: RateLimit | { exempt: string };
}

/**
 * The allowance for everyday changes (preferences, keys, endpoints, marking things read),
 * shared by all of them: far more than a person clicks, a ceiling for a runaway script.
 */
export const EVERYDAY_WRITES = {
  name: "writes",
  points: 120,
  windowSeconds: 60,
  per: "user",
  onRedisError: "allow",
} as const satisfies RateLimit;

export const base = oc.$meta<ProcedureMeta>({}).errors(errorsOf(...COMMON_ERRORS));
