import * as z from "zod";
import { keysOf } from "./objects";

/**
 * Every error code the API can return. Clients translate codes with the `errors.<CODE>`
 * keys in packages/i18n, so messages are always in the user's language, and branch on
 * codes (never on message text).
 *
 * The wire shape is oRPC's error JSON, the same over /rpc and REST (/api/v1), with the
 * HTTP status from this catalog:
 *   { code: "SHORT_NOT_FOUND", status: 404, message: "…", data: { requestId: "…", params: { … } } }
 * `message` is for logs only; clients translate `code`.
 *
 * Adding a code: add it here with its HTTP status, then add `errors.<CODE>` to every
 * catalog in packages/i18n (the i18n test fails until you do). `bun run gen` exports
 * the catalog to the Python service (packages/jobs/scripts/export-schemas.ts), which
 * derives its statuses from it too.
 */
export const ERROR_CODES = {
  // Generic
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  SERVICE_UNAVAILABLE: 503,
  // HTTP (answered before a procedure runs: the server, or oRPC, refused the request)
  METHOD_NOT_SUPPORTED: 405,
  TIMEOUT: 408,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  // Platform
  IDEMPOTENCY_IN_PROGRESS: 409,
  FEATURE_DISABLED: 404,
  /** 400, not 426: that one requires an Upgrade header naming a protocol to switch to. */
  CLIENT_OUTDATED: 400,
  FRESH_SESSION_REQUIRED: 403,
  /** safeFetch refused the address (private, internal, or not https). */
  DESTINATION_NOT_ALLOWED: 422,
  RESPONSE_TOO_LARGE: 502,
  TOO_MANY_REDIRECTS: 502,
  UPSTREAM_UNAVAILABLE: 502,
  // Tenancy
  NO_ACTIVE_ORGANIZATION: 403,
  // Files
  FILE_NOT_FOUND: 404,
  FILE_TYPE_NOT_ALLOWED: 422,
  FILE_TOO_LARGE: 413,
  /** The upload isn't the size the client declared when it asked to upload. */
  FILE_SIZE_MISMATCH: 422,
  FILE_INFECTED: 422,
  FILE_UNREADABLE: 422,
  FILE_NOT_UPLOADED: 409,
  FILE_NOT_READY: 409,
  // Inbound webhooks (the mail server): the signature doesn't match the body
  INVALID_SIGNATURE: 400,
  // AI
  AI_BUDGET_EXCEEDED: 429,
  // Shorts (YouTube) and Director
  SHORT_NOT_FOUND: 404,
  /** Director films shorts, not long videos (params: maxSeconds). */
  SHORT_TOO_LONG: 422,
  DIRECTOR_PLAN_NOT_FOUND: 404,
  /** The plan is still being worked out, or its analysis failed. */
  DIRECTOR_PLAN_NOT_READY: 409,
  DIRECTOR_SHOT_NOT_FOUND: 404,
  /** A photo for a video shot, or the other way round. */
  DIRECTOR_TAKE_KIND_MISMATCH: 422,
  /** A live call sent more than a person could say or type (each second costs Gemini time). */
  DIRECTOR_CALL_TOO_FAST: 429,
  // The next three are only ever a plan's or take's error, never an HTTP answer.
  /** Gemini couldn't watch the video (private, age-restricted, removed). */
  DIRECTOR_VIDEO_UNREADABLE: 422,
  DIRECTOR_ANALYSIS_FAILED: 422,
  DIRECTOR_REVIEW_FAILED: 422,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * The parameters a code's message needs (`errors.<CODE>` in packages/i18n), so throwing
 * the code without them is a type error rather than a message with a hole in it. Codes
 * not listed take no required parameters. The i18n tests check that each message's
 * placeholders are exactly these.
 */
export const ERROR_PARAMS = {
  RATE_LIMITED: z.object({ retryAfterSeconds: z.number().int().nonnegative() }),
  FILE_TYPE_NOT_ALLOWED: z.object({ types: z.string() }),
  FILE_TOO_LARGE: z.object({ maxBytes: z.number().int() }),
  SHORT_TOO_LONG: z.object({ maxSeconds: z.number().int() }),
} as const satisfies Partial<Record<ErrorCode, z.ZodObject>>;

type ParamsFree = Record<string, string | number>;
/** What `code` must be thrown with: its message's parameters, and any others. */
export type ErrorParams<C extends ErrorCode> = C extends keyof typeof ERROR_PARAMS
  ? z.infer<(typeof ERROR_PARAMS)[C]> & ParamsFree
  : ParamsFree;

export const errorCode = z.enum(keysOf(ERROR_CODES));

export const isErrorCode = (value: unknown): value is ErrorCode =>
  typeof value === "string" && Object.hasOwn(ERROR_CODES, value);

/**
 * The auth failures a user sees a sentence for (`authErrors.<CODE>` in packages/i18n;
 * anything else shows `authErrors.generic`). better-auth and its plugins answer with
 * their own codes, not ERROR_CODES: these are the ones people hit, ours from the auth
 * hooks (ORGANIZATION_NEEDS_OWNER), and the few catalog codes auth answers with too.
 *
 * Adding one: add it here and `authErrors.<CODE>` to every catalog (the i18n test fails
 * until you do). A code that means the same to a user as another goes in
 * AUTH_ERROR_ALIASES instead.
 */
export const AUTH_ERROR_CODES = [
  "INVALID_EMAIL_OR_PASSWORD",
  "EMAIL_NOT_VERIFIED",
  "USER_ALREADY_EXISTS",
  "PASSWORD_COMPROMISED",
  "INVALID_PASSWORD",
  "INVALID_OTP",
  "OTP_EXPIRED",
  "TOO_MANY_ATTEMPTS",
  "INVALID_CODE",
  "INVALID_BACKUP_CODE",
  "INVALID_TWO_FACTOR_COOKIE",
  "SESSION_EXPIRED",
  "PASSKEY_NOT_FOUND",
  "PREVIOUSLY_REGISTERED",
  "AUTHENTICATION_FAILED",
  "PASSKEY_CANCELLED",
  "ORGANIZATION_NEEDS_OWNER",
  "SIGN_IN_INCOMPLETE",
  // From ERROR_CODES.
  "VALIDATION_FAILED",
  "RATE_LIMITED",
] as const satisfies readonly string[];
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

/**
 * Codes that mean one of AUTH_ERROR_CODES to a user. Passkey prompts in particular fail
 * in browser-specific ways: dismissing the dialog surfaces as the browser's
 * NotAllowedError (ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY), an aborted ceremony, or the
 * plugin's own *_CANCELLED codes.
 */
export const AUTH_ERROR_ALIASES: Readonly<Record<string, AuthErrorCode>> = {
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "USER_ALREADY_EXISTS",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "TOO_MANY_ATTEMPTS",
  SESSION_NOT_FRESH: "SESSION_EXPIRED",
  AUTH_CANCELLED: "PASSKEY_CANCELLED",
  REGISTRATION_CANCELLED: "PASSKEY_CANCELLED",
  ERROR_CEREMONY_ABORTED: "PASSKEY_CANCELLED",
  ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY: "PASSKEY_CANCELLED",
  ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED: "PREVIOUSLY_REGISTERED",
};

export const isAuthErrorCode = (value: unknown): value is AuthErrorCode =>
  (AUTH_ERROR_CODES as readonly unknown[]).includes(value);
