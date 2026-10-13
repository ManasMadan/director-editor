import * as z from "zod";
import { keysOf } from "./objects";

/**
 * Every error code the API can return. Clients translate codes with the `errors.<CODE>`
 * keys in packages/i18n, so messages are always in the user's language, and branch on
 * codes (never on message text).
 *
 * The wire shape is oRPC's error JSON, the same over /rpc and REST (/api/v1), with the
 * HTTP status from this catalog:
 *   { code: "TODO_NOT_FOUND", status: 404, message: "…", data: { requestId: "…", params: { … } } }
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
  /** The same refusal as WEBHOOK_URL_NOT_ALLOWED, found later (at delivery), so the same status. */
  DESTINATION_NOT_ALLOWED: 422,
  RESPONSE_TOO_LARGE: 502,
  TOO_MANY_REDIRECTS: 502,
  UPSTREAM_UNAVAILABLE: 502,
  // Tenancy
  NO_ACTIVE_ORGANIZATION: 403,
  // Account
  PHONE_CODE_INVALID: 400,
  PHONE_NUMBER_TAKEN: 409,
  // Billing
  ENTITLEMENT_REQUIRED: 402,
  ALREADY_SUBSCRIBED: 409,
  NO_SUBSCRIPTION: 409,
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
  // Notifications
  UNSUBSCRIBE_LINK_INVALID: 400,
  // Inbound webhooks (Stripe, the mail server): the signature doesn't match the body
  INVALID_SIGNATURE: 400,
  // Webhooks
  WEBHOOK_ENDPOINT_NOT_FOUND: 404,
  WEBHOOK_DELIVERY_NOT_FOUND: 404,
  WEBHOOK_URL_NOT_ALLOWED: 422,
  WEBHOOK_ENDPOINT_LIMIT: 409,
  // Connected apps (OAuth / MCP clients)
  APP_NOT_FOUND: 404,
  // API keys
  API_KEY_NOT_FOUND: 404,
  API_KEY_LIMIT_REACHED: 409,
  /** The key is valid but lacks the scope this call needs (params: scope). */
  API_KEY_SCOPE_MISSING: 403,
  // AI
  DOCUMENT_NOT_FOUND: 404,
  // DOCUMENT_INDEXING_FAILED (a document's error) and AI_RUN_LIMIT (an answer's) are never
  // HTTP answers, only codes inside a response; their statuses are there for the catalog.
  DOCUMENT_INDEXING_FAILED: 422,
  AI_BUDGET_EXCEEDED: 429,
  AI_RUN_LIMIT: 422,
  // Todos (example feature)
  TODO_NOT_FOUND: 404,
  TODO_VERSION_CONFLICT: 409,
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
  WEBHOOK_ENDPOINT_LIMIT: z.object({ max: z.number().int() }),
  FILE_TYPE_NOT_ALLOWED: z.object({ types: z.string() }),
  FILE_TOO_LARGE: z.object({ maxBytes: z.number().int() }),
  API_KEY_SCOPE_MISSING: z.object({ scope: z.string() }),
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
  "OAUTH_REQUEST_EXPIRED",
  "SIGN_IN_INCOMPLETE",
  // From ERROR_CODES.
  "VALIDATION_FAILED",
  "RATE_LIMITED",
  "ENTITLEMENT_REQUIRED",
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
  ORGANIZATION_MEMBERSHIP_LIMIT_REACHED: "ENTITLEMENT_REQUIRED",
  // OAuth errors (the `error` field): the signed request an app sent the user with has
  // expired (it's valid for 10 minutes) or was altered.
  invalid_signature: "OAUTH_REQUEST_EXPIRED",
};

export const isAuthErrorCode = (value: unknown): value is AuthErrorCode =>
  (AUTH_ERROR_CODES as readonly unknown[]).includes(value);
