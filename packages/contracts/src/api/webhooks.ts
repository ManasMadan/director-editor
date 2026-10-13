/**
 * Customer webhook endpoints and their delivery log (organization owners and admins).
 * Deliveries are signed per Standard Webhooks; see apps/webhooks.
 */
import * as z from "zod";
import { webhookEvents } from "../events";
import { webhookDeliveryIdSchema, webhookEndpointIdSchema } from "../ids";
import { page, pageInput } from "../pagination";
import { base, EVERYDAY_WRITES, errorsOf, WORKSPACE_ERRORS } from "./base";

/** The codes this module's procedures throw, on top of the common ones. */
const errors = errorsOf(
  ...WORKSPACE_ERRORS,
  "FRESH_SESSION_REQUIRED",
  "ENTITLEMENT_REQUIRED",
  "UPSTREAM_UNAVAILABLE",
  "WEBHOOK_ENDPOINT_NOT_FOUND",
  "WEBHOOK_DELIVERY_NOT_FOUND",
  "WEBHOOK_ENDPOINT_LIMIT",
  "WEBHOOK_URL_NOT_ALLOWED",
);

export const WEBHOOK_ENDPOINT_LIMIT = 20;
/**
 * After a rotation the old signing secret still signs deliveries (next to the new one)
 * for this long, so a customer can update their receiver without dropping any.
 */
export const WEBHOOK_SECRET_OVERLAP_HOURS = 24;

export const webhookEndpointSchema = z.object({
  id: webhookEndpointIdSchema,
  url: z.url(),
  description: z.string(),
  /** Subscribed events; empty means all of them. */
  events: z.array(z.enum(webhookEvents)),
  createdAt: z.date(),
  disabledAt: z.date().nullable(),
  /** "manual" (an admin turned it off) or "failing" (it stopped answering). */
  disabledReason: z.enum(["manual", "failing"]).nullable(),
});
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>;

/**
 * Why an attempt failed without an HTTP status, as a code (the apps translate it), never
 * our own error message. A response with a status records the status instead.
 */
const WEBHOOK_DELIVERY_ERRORS = [
  "timeout",
  "connection_failed",
  "destination_not_allowed",
  "response_too_large",
  "endpoint_disabled",
] as const;
export type WebhookDeliveryError = (typeof WEBHOOK_DELIVERY_ERRORS)[number];

export const webhookDeliverySchema = z.object({
  id: webhookDeliveryIdSchema,
  eventName: z.string(),
  status: z.enum(["pending", "succeeded", "failed"]),
  attempts: z.number().int(),
  lastStatus: z.number().int().nullable(),
  lastError: z.enum(WEBHOOK_DELIVERY_ERRORS).nullable(),
  lastAttemptAt: z.date().nullable(),
  createdAt: z.date(),
});
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;

// A DNS name is at most 253 characters: a longer host can never resolve, and the lookup
// refuses it as malformed (EINVAL), which would otherwise read as DNS being down.
const endpointUrl = z.url({ protocol: /^https?$/, hostname: /^.{1,253}$/ }).max(2048);
const endpointFields = {
  description: z.string().trim().max(200).optional(),
  events: z.array(z.enum(webhookEvents)).max(webhookEvents.length).optional(),
};
const endpointId = z.object({ id: webhookEndpointIdSchema });
/** The signing secret, shown once: store it to verify our signatures. */
const withSecret = z.object({ secret: z.string().startsWith("whsec_") });

const route = (method: "GET" | "POST" | "PATCH" | "DELETE", path: `/${string}`, summary: string) =>
  base.errors(errors).route({ method, path, tags: ["Webhooks"], summary });

export const webhooksContract = {
  listEndpoints: route("GET", "/webhooks/endpoints", "List webhook endpoints").output(
    z.array(webhookEndpointSchema),
  ),
  createEndpoint: route("POST", "/webhooks/endpoints", "Add a webhook endpoint")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(z.object({ url: endpointUrl, ...endpointFields }))
    .output(z.object({ endpoint: webhookEndpointSchema }).extend(withSecret.shape)),
  updateEndpoint: route("PATCH", "/webhooks/endpoints/{id}", "Change or turn an endpoint on/off")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(
      endpointId.extend({
        url: endpointUrl.optional(),
        enabled: z.boolean().optional(),
        ...endpointFields,
      }),
    )
    .output(webhookEndpointSchema),
  deleteEndpoint: route("DELETE", "/webhooks/endpoints/{id}", "Delete an endpoint")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(endpointId)
    .output(z.void()),
  rotateSecret: route(
    "POST",
    "/webhooks/endpoints/{id}/rotate-secret",
    "Replace the signing secret",
  )
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(endpointId)
    .output(withSecret),
  // Each of these two sends a request to the customer's URL: without a limit, our servers
  // could be pointed at someone's endpoint as a flood.
  sendTest: route("POST", "/webhooks/endpoints/{id}/test", "Send a test event")
    .meta({ rateLimit: { name: "webhook-tests", points: 10, windowSeconds: 60, per: "org" } })
    .input(endpointId)
    .output(z.void()),
  listDeliveries: route(
    "GET",
    "/webhooks/endpoints/{id}/deliveries",
    "An endpoint's recent deliveries",
  )
    .input(endpointId.extend(pageInput.shape))
    .output(page(webhookDeliverySchema)),
  redeliver: route("POST", "/webhooks/deliveries/{id}/redeliver", "Send a delivery again")
    .meta({
      rateLimit: { name: "webhook-redeliveries", points: 60, windowSeconds: 60, per: "org" },
    })
    .input(z.object({ id: webhookDeliveryIdSchema }))
    .output(z.void()),
};
