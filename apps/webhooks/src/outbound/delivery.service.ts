/**
 * Sends one delivery attempt and records the outcome.
 *
 * The request goes through safeFetch (no private addresses, pinned DNS, capped time and
 * response size), signed per Standard Webhooks. Any 2xx is success. Anything else is a
 * failure BullMQ retries on the delivery schedule. When the last retry fails, and the
 * endpoint hasn't succeeded for WEBHOOK_AUTO_DISABLE_HOURS, the endpoint is disabled
 * and `webhook.endpoint_disabled.v1` tells the organization's admins (notifications).
 */
import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type { WebhookDeliveryError } from "@repo/contracts/api";
import {
  type OrgId,
  type WebhookDeliveryId,
  type WebhookEndpointId,
  webhookDeliveryIdSchema,
  webhookEndpointIdSchema,
} from "@repo/contracts/ids";
import { HOUR_MS } from "@repo/contracts/time";
import { tenantTx, withTenant } from "@repo/db";
import {
  type Database,
  describeError,
  InjectDatabase,
  InjectPinoLogger,
  isAppError,
  keysFromEnv,
  PinoLogger,
  SecretBox,
  safeFetch,
  webhookSecretContext,
} from "@repo/nest-common";
import { env } from "../env";
import { emitEvent } from "../outbox";
import { signatureHeaders } from "./signing";

export type AttemptResult = "succeeded" | "retry" | "failed" | "skipped";

const USER_AGENT = "Boilerplate-Webhooks/1.0 (+https://www.standardwebhooks.com)";

@Injectable()
export class DeliveryService {
  private readonly box = new SecretBox(keysFromEnv(env.ENCRYPTION_KEYS));

  constructor(
    @InjectDatabase() private readonly database: Database,
    @InjectPinoLogger(DeliveryService.name) private readonly log: PinoLogger,
  ) {}

  /** The endpoint's signing secrets, newest first: the previous one until its overlap ends. */
  private secretsOf(endpoint: {
    id: string;
    secret: string;
    previousSecret: string | null;
    previousSecretExpiresAt: Date | null;
  }) {
    const context = webhookSecretContext(endpoint.id);
    const secrets = [this.box.decrypt(endpoint.secret, context)];
    if (endpoint.previousSecret && (endpoint.previousSecretExpiresAt ?? new Date(0)) > new Date()) {
      secrets.push(this.box.decrypt(endpoint.previousSecret, context));
    }
    return secrets;
  }

  /** Posts the body to the endpoint: the status it answered, or why there was none. */
  private async post(
    url: string,
    headers: Record<string, string>,
    body: string,
    ids: { orgId: OrgId; deliveryId: WebhookDeliveryId },
  ): Promise<{ status?: number; error?: WebhookDeliveryError }> {
    try {
      const response = await safeFetch(url, {
        method: "POST",
        headers,
        body,
        timeoutMs: env.WEBHOOK_TIMEOUT_MS,
        maxResponseBytes: 64 * 1024,
        allowHttp: env.NODE_ENV !== "production",
        allowedPrivateAddresses: env.WEBHOOK_ALLOWED_PRIVATE_ADDRESSES,
        // A redirect is a failed delivery: following it would send the body and its
        // signature to wherever it points.
        followRedirects: false,
      });
      return { status: response.status };
    } catch (cause) {
      const error = deliveryError(cause);
      this.log.info({ ...ids, error, err: describeError(cause) }, "webhook attempt failed");
      return { error };
    }
  }

  /** One attempt. `isLastAttempt`: no retry follows if this one fails. */
  async attempt(
    orgId: OrgId,
    deliveryId: WebhookDeliveryId,
    isLastAttempt: boolean,
  ): Promise<AttemptResult> {
    const tenant = withTenant(this.database.write, orgId);
    const delivery = await tenant.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: {
        endpoint: {
          select: {
            id: true,
            url: true,
            secret: true,
            previousSecret: true,
            previousSecretExpiresAt: true,
            disabledAt: true,
          },
        },
      },
    });
    if (!delivery) {
      // Under row-level security a wrong organization looks exactly like a missing row.
      this.log.warn({ orgId, deliveryId }, "webhook delivery not found; skipped");
      return "skipped";
    }
    if (delivery.status !== "pending") {
      return "skipped";
    }
    if (delivery.endpoint.disabledAt) {
      await tenant.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: "failed", lastError: "endpoint_disabled" },
      });
      return "skipped";
    }

    // Before the attempt, outside its try: failing to sign (a missing encryption key) is
    // our fault, not the endpoint's, so it fails the job (logged, retried) and never
    // counts against the endpoint or disables it.
    const headers = {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      ...signatureHeaders(this.secretsOf(delivery.endpoint), delivery.eventId, delivery.body),
    };
    const started = performance.now();
    const { status, error } = await this.post(delivery.endpoint.url, headers, delivery.body, {
      orgId,
      deliveryId,
    });
    const succeeded = status !== undefined && status >= 200 && status < 300;
    let outcome: AttemptResult = "retry";
    if (succeeded) {
      outcome = "succeeded";
    } else if (isLastAttempt) {
      outcome = "failed";
    }

    await tenant.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        attempts: { increment: 1 },
        lastAttemptAt: new Date(),
        lastStatus: status ?? null,
        lastError: error ?? null,
        lastDurationMs: Math.round(performance.now() - started),
        ...(outcome === "succeeded" && { status: "succeeded", succeededAt: new Date() }),
        ...(outcome === "failed" && { status: "failed" }),
      },
    });
    if (outcome === "failed") {
      await this.disableIfFailing(
        orgId,
        webhookEndpointIdSchema.parse(delivery.endpoint.id),
        delivery.endpoint.url,
      );
    }
    return outcome;
  }

  /** Puts a finished delivery back in the queue's hands (admin replay). */
  async reset(orgId: OrgId, deliveryId: WebhookDeliveryId) {
    const { count } = await withTenant(this.database.write, orgId).webhookDelivery.updateMany({
      where: { id: deliveryId, status: { not: "pending" } },
      data: { status: "pending" },
    });
    return count === 1;
  }

  /** Creates (once per `eventId`) a delivery of a test event to one endpoint; returns its id. */
  async createTest(orgId: OrgId, endpointId: WebhookEndpointId, eventId: string = randomUUID()) {
    const body = JSON.stringify({
      type: "webhook.test",
      timestamp: new Date().toISOString(),
      data: { message: "This is a test event from your webhook settings." },
    });
    const delivery = await withTenant(this.database.write, orgId).webhookDelivery.upsert({
      where: { endpointId_eventId: { endpointId, eventId } },
      create: { endpointId, orgId, eventId, eventName: "webhook.test", body },
      update: {},
      select: { id: true },
    });
    return webhookDeliveryIdSchema.parse(delivery.id);
  }

  private async disableIfFailing(orgId: OrgId, endpointId: WebhookEndpointId, url: string) {
    await tenantTx(this.database.write, orgId, async (tx) => {
      const lastSuccess = await tx.webhookDelivery.findFirst({
        where: { endpointId, status: "succeeded" },
        orderBy: { succeededAt: "desc" },
        select: { succeededAt: true },
      });
      const firstFailureSince = await tx.webhookDelivery.findFirst({
        where: {
          endpointId,
          status: "failed",
          ...(lastSuccess?.succeededAt && { createdAt: { gt: lastSuccess.succeededAt } }),
        },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      });
      const failingFor = firstFailureSince ? Date.now() - firstFailureSince.createdAt.getTime() : 0;
      if (failingFor < env.WEBHOOK_AUTO_DISABLE_HOURS * HOUR_MS) {
        return;
      }

      const { count } = await tx.webhookEndpoint.updateMany({
        where: { id: endpointId, disabledAt: null },
        data: { disabledAt: new Date(), disabledReason: "failing" },
      });
      if (count === 0) {
        return;
      }
      await emitEvent(
        tx,
        "webhook.endpoint_disabled.v1",
        endpointId,
        { endpointId, url, reason: "failing" },
        { orgId, actorId: null },
      );
      this.log.warn({ endpointId, orgId }, "webhook endpoint disabled after failing continuously");
    });
  }
}

/**
 * What went wrong reaching the endpoint, as a code for tenants to see. Anything that
 * isn't about the endpoint is rethrown: it's our bug, and it fails the job instead.
 */
export function deliveryError(cause: unknown): WebhookDeliveryError {
  if (isAppError(cause)) {
    if (cause.code === "DESTINATION_NOT_ALLOWED") {
      return "destination_not_allowed";
    }
    if (cause.code === "RESPONSE_TOO_LARGE") {
      return "response_too_large";
    }
    throw cause;
  }
  if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
    return "timeout";
  }
  // undici: "fetch failed", with the socket's reason (refused, reset, DNS, TLS) as cause.
  if (cause instanceof TypeError && cause.message === "fetch failed") {
    return "connection_failed";
  }
  throw cause;
}
