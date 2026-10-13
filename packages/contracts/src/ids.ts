/**
 * Branded ids: one type per kind of id, so passing a workspace's id where a user's
 * belongs, or swapping `(orgId, userId)`, is a compile error instead of a query that
 * quietly finds nothing (or the wrong rows).
 *
 * Every id is a UUID string at run time; the brand exists only for the compiler. A
 * branded id is still a string, so it goes anywhere a string does (Prisma, logs, URLs),
 * but a plain string never passes as one: it has to come through its schema here, which
 * checks it is a UUID. That happens once, where the id enters the code:
 *
 *   - API input and output: the contract's schemas use these, so a handler's input and a
 *     client's response carry the brand;
 *   - queue payloads and events: `parseJob` parses them through the same schemas;
 *   - better-auth's users, sessions and organizations: the API's auth adapter
 *     (apps/api/src/auth/ids.ts);
 *   - a database row, which Prisma types as a plain string: `orgIdSchema.parse(row.orgId)`
 *     where the code hands it on.
 *
 * Never cast a string to one of these: parse it.
 */
import * as z from "zod";

export const orgIdSchema = z.uuid().brand<"OrgId">();
export type OrgId = z.infer<typeof orgIdSchema>;

export const userIdSchema = z.uuid().brand<"UserId">();
export type UserId = z.infer<typeof userIdSchema>;

export const todoIdSchema = z.uuid().brand<"TodoId">();
export type TodoId = z.infer<typeof todoIdSchema>;

export const fileIdSchema = z.uuid().brand<"FileId">();
export type FileId = z.infer<typeof fileIdSchema>;

export const documentIdSchema = z.uuid().brand<"DocumentId">();
export type DocumentId = z.infer<typeof documentIdSchema>;

export const notificationIdSchema = z.uuid().brand<"NotificationId">();
export type NotificationId = z.infer<typeof notificationIdSchema>;

export const apiKeyIdSchema = z.uuid().brand<"ApiKeyId">();
export type ApiKeyId = z.infer<typeof apiKeyIdSchema>;

export const webhookEndpointIdSchema = z.uuid().brand<"WebhookEndpointId">();
export type WebhookEndpointId = z.infer<typeof webhookEndpointIdSchema>;

export const webhookDeliveryIdSchema = z.uuid().brand<"WebhookDeliveryId">();
export type WebhookDeliveryId = z.infer<typeof webhookDeliveryIdSchema>;
