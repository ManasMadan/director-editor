/**
 * Routes that take their body as the raw bytes sent: to check a signature over exactly
 * those bytes (provider webhooks), or because the handler reads it itself (better-auth,
 * the MCP transport). Call it inside a `fastify.register` scope, so only that scope's
 * routes lose the app's parsers.
 *
 *   fastify.register((scope, _options, done) => {
 *     rawBodies(scope, "application/json");
 *     scope.post("/webhooks/stripe", handler); // request.body is a Buffer
 *     done();
 *   });
 */
import type { FastifyInstance } from "fastify";

/** `type`: the content type to take raw, or "*" for every one. */
export function rawBodies(scope: FastifyInstance, type = "*") {
  if (type === "*") {
    scope.removeAllContentTypeParsers();
  } else {
    scope.removeContentTypeParser(type);
  }
  scope.addContentTypeParser(type, { parseAs: "buffer" }, (_request, body, done) =>
    done(null, body),
  );
}
