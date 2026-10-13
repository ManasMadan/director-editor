/**
 * POST /webhooks/stripe: Stripe's events, verified, recorded once, handed to billing.
 *
 * Verification needs the exact bytes Stripe signed, so this route reads the raw body.
 * Each Stripe event id is stored once (webhooks.inbound_event is unique on it): Stripe
 * retries until it gets a 2xx and may send an event twice, and both are harmless. The
 * event and a `stripe.event_received.v1` outbox row are written in one transaction, so
 * billing (apps/api, via the relay) gets every event exactly once. Stripe expects an
 * answer within seconds, so nothing is processed here.
 */
import { transaction } from "@repo/db";
import type { Database } from "@repo/nest-common";
import { rawBodies, sendError } from "@repo/nest-common";
import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { emitEvent } from "../outbox";
import { jsonObject } from "./json";

export function mountStripe(
  fastify: FastifyInstance,
  database: Database,
  secret: string | undefined,
) {
  fastify.register((scope, _options, done) => {
    // Raw bytes for this route only (this plugin scope): the signature covers the body
    // exactly as sent, so the JSON parser inherited from the app is replaced here.
    rawBodies(scope, "application/json");

    scope.post("/webhooks/stripe", async (request, reply) => {
      if (!secret) {
        return sendError(reply, "NOT_FOUND");
      }
      const signature = request.headers["stripe-signature"];
      if (typeof signature !== "string" || !Buffer.isBuffer(request.body)) {
        return sendError(reply, "BAD_REQUEST");
      }

      let event: Stripe.Event;
      try {
        event = await Stripe.webhooks.constructEventAsync(request.body, signature, secret);
      } catch {
        return sendError(reply, "INVALID_SIGNATURE");
      }

      await transaction(database.write, async (tx) => {
        const inserted = await tx.webhookInboundEvent.createManyAndReturn({
          data: [
            {
              provider: "stripe",
              providerEventId: event.id,
              type: event.type,
              payload: jsonObject.parse(event),
            },
          ],
          skipDuplicates: true,
          select: { id: true },
        });
        const row = inserted[0];
        if (!row) {
          return; // already received: acknowledge, don't process twice
        }
        await emitEvent(
          tx,
          "stripe.event_received.v1",
          event.id,
          {
            inboundEventId: row.id,
            stripeEventId: event.id,
            type: event.type,
            object: jsonObject.parse(event.data.object),
          },
          { actorId: null, orgId: null },
        );
      });
      return reply.status(200).send({ received: true });
    });
    done();
  });
}
