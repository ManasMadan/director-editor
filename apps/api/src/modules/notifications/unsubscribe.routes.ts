/**
 * POST /api/v1/notifications/unsubscribe?token=…: RFC 8058 one-click unsubscribe. Mail
 * clients (Gmail, Apple Mail) POST `List-Unsubscribe=One-Click` to the URL in the email's
 * List-Unsubscribe header, with no session and no page, and expect a 2xx. The signed
 * token in the URL says who and which category. People clicking the link in the email
 * body land on the web app's /unsubscribe page instead.
 */

import { rawBodies, sendError } from "@repo/nest-common";
import type { FastifyInstance } from "fastify";
import type { NotificationsService } from "./notifications.service";

export function mountOneClickUnsubscribe(
  fastify: FastifyInstance,
  notifications: NotificationsService,
) {
  fastify.register((scope, _options, done) => {
    // The body is a form field we don't need; accept it without parsing (replacing the
    // app's form parser in this scope only).
    rawBodies(scope, "application/x-www-form-urlencoded");
    scope.post<{ Querystring: { token?: string } }>(
      "/api/v1/notifications/unsubscribe",
      async (request, reply) => {
        const token = request.query.token;
        if (!token) {
          return sendError(reply, "UNSUBSCRIBE_LINK_INVALID");
        }
        // A bad link throws UNSUBSCRIBE_LINK_INVALID, which the error filter answers;
        // anything else (the database down) is a logged 500, not "invalid link".
        await notifications.unsubscribe(token);
        return reply.status(200).send({ unsubscribed: true });
      },
    );
    done();
  });
}
