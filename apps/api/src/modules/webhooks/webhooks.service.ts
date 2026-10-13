/**
 * Customer webhook endpoints: configuration rules, the signing secret, and hand-offs to
 * apps/webhooks (test events, replays). Every change is audited in the same transaction.
 */
import { randomUUID } from "node:crypto";
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import {
  WEBHOOK_ENDPOINT_LIMIT,
  WEBHOOK_SECRET_OVERLAP_HOURS,
  type WebhookEndpoint,
  webhookDeliverySchema,
  webhookEndpointSchema,
} from "@repo/contracts/api";
import type { EventPayload, WebhookEventName } from "@repo/contracts/events";
import {
  type OrgId,
  type UserId,
  type WebhookDeliveryId,
  type WebhookEndpointId,
  webhookEndpointIdSchema,
} from "@repo/contracts/ids";
import { type PageInput, toPage } from "@repo/contracts/pagination";
import { HOUR_MS } from "@repo/contracts/time";
import { tenantTx } from "@repo/db";
import type { Producer } from "@repo/jobs";
import {
  AppError,
  type Database,
  InjectDatabase,
  keysFromEnv,
  newWebhookSecret,
  SecretBox,
  webhookSecretContext,
} from "@repo/nest-common";
import { env } from "../../env";
import { emitEvent } from "../../outbox";
import { BillingService } from "../billing";
import { assertDeliverableUrl } from "./webhook-url";
import { WebhooksRepository } from "./webhooks.repository";

export const WEBHOOK_DELIVERIES = Symbol("WEBHOOK_DELIVERIES");

type EndpointRow = Awaited<ReturnType<WebhooksRepository["listEndpoints"]>>[number];

const toEndpoint = (row: EndpointRow): WebhookEndpoint => webhookEndpointSchema.parse(row);

type Changed = EventPayload<"webhook.endpoint_updated.v1">["changed"];

interface EndpointUpdate {
  id: WebhookEndpointId;
  url?: string | undefined;
  description?: string | undefined;
  events?: WebhookEventName[] | undefined;
  enabled?: boolean | undefined;
}

/** What an update really changes on the endpoint (`events` counts whenever it's given). */
function changesOf(
  input: EndpointUpdate,
  current: { url: string; description: string | null; disabledAt: Date | null },
): Changed {
  const changed: Changed = [];
  if (input.url !== undefined && input.url !== current.url) {
    changed.push("url");
  }
  if (input.description !== undefined && input.description !== current.description) {
    changed.push("description");
  }
  if (input.events !== undefined) {
    changed.push("events");
  }
  if (input.enabled !== undefined && input.enabled !== (current.disabledAt === null)) {
    changed.push("enabled");
  }
  return changed;
}

/** The columns that turn an endpoint on, or off by hand. */
const enabling = (enabled: boolean) =>
  enabled
    ? { disabledAt: null, disabledReason: null }
    : { disabledAt: new Date(), disabledReason: "manual" };

@Injectable()
export class WebhooksService implements OnApplicationShutdown {
  private readonly box = new SecretBox(keysFromEnv(env.ENCRYPTION_KEYS));

  constructor(
    @InjectDatabase() private readonly database: Database,
    private readonly repository: WebhooksRepository,
    @Inject(WEBHOOK_DELIVERIES) private readonly deliveries: Producer<"webhook-deliveries">,
    private readonly billing: BillingService,
  ) {}

  async listEndpoints(orgId: OrgId) {
    return (await this.repository.listEndpoints(orgId)).map(toEndpoint);
  }

  async createEndpoint(
    orgId: OrgId,
    userId: UserId,
    input: {
      url: string;
      description?: string | undefined;
      events?: WebhookEventName[] | undefined;
    },
  ) {
    // Existing endpoints keep working after a downgrade; new ones need the plan.
    await this.billing.require(orgId, "webhooks");
    await assertDeliverableUrl(input.url);
    const secret = newWebhookSecret();
    // Chosen here, not by the database: the secret is encrypted for its row.
    const id = webhookEndpointIdSchema.parse(randomUUID());
    return tenantTx(this.database.write, orgId, async (tx) => {
      if ((await this.repository.countEndpoints(tx)) >= WEBHOOK_ENDPOINT_LIMIT) {
        throw new AppError("WEBHOOK_ENDPOINT_LIMIT", { params: { max: WEBHOOK_ENDPOINT_LIMIT } });
      }
      const endpoint = await this.repository.createEndpoint(tx, {
        id,
        orgId,
        url: input.url,
        description: input.description ?? "",
        events: input.events ?? [],
        secret: this.box.encrypt(secret, webhookSecretContext(id)),
        createdById: userId,
      });
      await emitEvent(tx, "webhook.endpoint_created.v1", id, { endpointId: id, url: endpoint.url });
      return { endpoint: toEndpoint(endpoint), secret };
    });
  }

  async updateEndpoint(orgId: OrgId, input: EndpointUpdate) {
    if (input.url !== undefined) {
      await assertDeliverableUrl(input.url);
    }
    return tenantTx(this.database.write, orgId, async (tx) => {
      const current = await this.repository.findEndpoint(tx, input.id);
      if (!current) {
        throw new AppError("WEBHOOK_ENDPOINT_NOT_FOUND", { params: { id: input.id } });
      }
      const changed = changesOf(input, current);
      const endpoint = await this.repository.updateEndpoint(tx, input.id, {
        ...(input.url !== undefined && { url: input.url }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.events !== undefined && { events: input.events }),
        ...(changed.includes("enabled") && enabling(input.enabled === true)),
      });
      if (changed.length > 0) {
        await emitEvent(tx, "webhook.endpoint_updated.v1", input.id, {
          endpointId: input.id,
          changed,
        });
      }
      return toEndpoint(endpoint);
    });
  }

  deleteEndpoint(orgId: OrgId, id: WebhookEndpointId) {
    return tenantTx(this.database.write, orgId, async (tx) => {
      const current = await this.repository.findEndpoint(tx, id);
      if (!current) {
        throw new AppError("WEBHOOK_ENDPOINT_NOT_FOUND", { params: { id } });
      }
      await this.repository.deleteEndpoint(tx, id);
      await emitEvent(tx, "webhook.endpoint_deleted.v1", id, { endpointId: id, url: current.url });
    });
  }

  /**
   * A new signing secret. The one it replaces keeps signing too until the overlap ends
   * (WEBHOOK_SECRET_OVERLAP_HOURS); rotating again inside that window drops the older
   * one, since its replacement was never put to use.
   */
  rotateSecret(orgId: OrgId, id: WebhookEndpointId) {
    const secret = newWebhookSecret();
    return tenantTx(this.database.write, orgId, async (tx) => {
      const current = await this.repository.findSecret(tx, id);
      if (!current) {
        throw new AppError("WEBHOOK_ENDPOINT_NOT_FOUND", { params: { id } });
      }
      await this.repository.setSecret(tx, id, {
        secret: this.box.encrypt(secret, webhookSecretContext(id)),
        // Same row, so the same context: the ciphertext moves as it is.
        previousSecret: current.secret,
        previousSecretExpiresAt: new Date(Date.now() + WEBHOOK_SECRET_OVERLAP_HOURS * HOUR_MS),
      });
      await emitEvent(tx, "webhook.secret_rotated.v1", id, { endpointId: id });
      return { secret };
    });
  }

  async sendTest(orgId: OrgId, endpointId: WebhookEndpointId) {
    if (!(await this.repository.endpointExists(orgId, endpointId))) {
      throw new AppError("WEBHOOK_ENDPOINT_NOT_FOUND", { params: { id: endpointId } });
    }
    await this.deliveries.add(
      "send-test",
      { endpointId, orgId },
      { jobId: randomUUID(), meta: { orgId } },
    );
  }

  async listDeliveries(orgId: OrgId, endpointId: WebhookEndpointId, page: PageInput) {
    if (!(await this.repository.endpointExists(orgId, endpointId))) {
      throw new AppError("WEBHOOK_ENDPOINT_NOT_FOUND", { params: { id: endpointId } });
    }
    const rows = await this.repository.listDeliveries(orgId, endpointId, page);
    // Parsed, not cast: the columns are text. A code the contract doesn't know (a row from
    // before the codes) reads as the nearest, a failed connection.
    const { status, lastError } = webhookDeliverySchema.shape;
    const knownError = lastError.catch("connection_failed");
    return toPage(
      rows.map((row) => ({
        ...row,
        status: status.parse(row.status),
        lastError: knownError.parse(row.lastError),
      })),
      page.limit,
    );
  }

  async redeliver(orgId: OrgId, deliveryId: WebhookDeliveryId) {
    if (!(await this.repository.deliveryExists(orgId, deliveryId))) {
      throw new AppError("WEBHOOK_DELIVERY_NOT_FOUND", { params: { id: deliveryId } });
    }
    await this.deliveries.add(
      "redeliver",
      { deliveryId, orgId },
      { jobId: randomUUID(), meta: { orgId } },
    );
  }

  async onApplicationShutdown() {
    await this.deliveries.close();
  }
}
