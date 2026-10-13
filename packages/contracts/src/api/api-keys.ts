/**
 * The workspace's API keys, for scripts and third-party integrations calling the REST
 * API (organization owners and admins manage them).
 *
 * A key belongs to the workspace and acts as the admin who created it, only in that
 * workspace and only within its scopes: it stops working when it's revoked, expires, or
 * its creator leaves the workspace. The key itself is shown once, at creation; only its
 * hash is stored.
 */
import * as z from "zod";
import { apiKeyIdSchema, userIdSchema } from "../ids";
import { base, EVERYDAY_WRITES, errorsOf, WORKSPACE_ERRORS } from "./base";
import { API_KEY_PREFIX, API_KEY_SCOPES } from "./scopes";

/** The codes this module's procedures throw, on top of the common ones. */
const errors = errorsOf(
  ...WORKSPACE_ERRORS,
  "FRESH_SESSION_REQUIRED",
  "API_KEY_LIMIT_REACHED",
  "API_KEY_NOT_FOUND",
);

export const API_KEY_NAME_MAX_LENGTH = 64;
export const API_KEY_LIMIT = 50;
/** Requests each key may make per minute (RATE_LIMITED beyond that). */
export const API_KEY_REQUESTS_PER_MINUTE = 600;
/** Choices offered when creating a key. Every key expires, so a stolen session can't leave one for good. */
export const API_KEY_EXPIRY_DAYS = [30, 90, 365] as const;
/** The longest a key lives; `expiresInDays: null` (formerly "never") gets this. */
export const MAX_API_KEY_DAYS = 365;

const apiKeySchema = z.object({
  id: apiKeyIdSchema,
  name: z.string(),
  /** The first characters of the key (with its prefix), to recognise it. */
  start: z.string(),
  scopes: z.array(z.enum(API_KEY_SCOPES)),
  /** Who created it (and so who it acts as); null once they've deleted their account. */
  createdBy: z.object({ id: userIdSchema, name: z.string() }).nullable(),
  createdAt: z.date(),
  expiresAt: z.date().nullable(),
  lastUsedAt: z.date().nullable(),
});
export type ApiKey = z.infer<typeof apiKeySchema>;

export const createApiKeyInput = z.object({
  name: z.string().trim().min(1).max(API_KEY_NAME_MAX_LENGTH),
  scopes: z
    .array(z.enum(API_KEY_SCOPES))
    .min(1)
    .max(API_KEY_SCOPES.length)
    .refine((scopes) => new Set(scopes).size === scopes.length, { message: "duplicate" }),
  expiresInDays: z
    .union([...API_KEY_EXPIRY_DAYS.map((days) => z.literal(days))])
    .nullable()
    .describe(
      `Days until the key expires. null is kept for old clients and means ${MAX_API_KEY_DAYS}.`,
    ),
});

export const apiKeysContract = {
  list: base
    .errors(errors)
    .route({ method: "GET", path: "/api-keys", tags: ["API keys"], summary: "List API keys" })
    .output(z.array(apiKeySchema)),
  /** API_KEY_LIMIT keys per workspace (API_KEY_LIMIT_REACHED beyond that). */
  create: base
    .errors(errors)
    .meta({ rateLimit: EVERYDAY_WRITES })
    .route({
      method: "POST",
      path: "/api-keys",
      tags: ["API keys"],
      summary: "Create an API key",
      successStatus: 201,
    })
    .input(createApiKeyInput)
    .output(
      z.object({
        apiKey: apiKeySchema,
        /** The key itself: shown only now. Send it in the `x-api-key` header. */
        key: z.string().startsWith(API_KEY_PREFIX),
      }),
    ),
  /** The key stops working immediately (API_KEY_NOT_FOUND for another workspace's key). */
  revoke: base
    .errors(errors)
    .meta({ rateLimit: EVERYDAY_WRITES })
    .route({
      method: "DELETE",
      path: "/api-keys/{id}",
      tags: ["API keys"],
      summary: "Revoke an API key",
      successStatus: 204,
    })
    .input(z.object({ id: apiKeyIdSchema }))
    .output(z.void()),
};
