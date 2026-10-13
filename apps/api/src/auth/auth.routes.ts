/**
 * Serves better-auth under /api/auth/*, and the OAuth discovery documents it answers at
 * the site root (/.well-known/oauth-authorization-server/api/auth,
 * /.well-known/openid-configuration/api/auth and
 * /.well-known/oauth-protected-resource/api/mcp).
 *
 * The routes live in their own Fastify scope that keeps every request body as raw bytes:
 * better-auth reads JSON from the browser and form-encoded bodies from OAuth clients
 * (the token, revoke and introspect endpoints), so it gets the body exactly as sent.
 * The request carries the verified client IP. Set-Cookie headers are copied one by one:
 * joining them with commas (what a plain header copy does) corrupts cookie attributes.
 */

import { rawBodies, runWithContext, updateContext } from "@repo/nest-common";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { contextFor, fromWebResponse, toHeaders, toWebRequest } from "../http-context";
import type { Auth } from "./auth";

/**
 * better-auth's error, in the envelope every other error has (status, request id,
 * params), keeping its own code and message, which its clients read. OAuth errors
 * (`{ error, error_description }`, RFC 6749) stay as the spec has them.
 */
export function authErrorBody(body: Buffer, status: number, requestId: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || "error" in parsed) {
    return null;
  }
  const { code, message } = parsed as { code?: unknown; message?: unknown };
  if (typeof code !== "string") {
    return null;
  }
  return {
    defined: false,
    code,
    status,
    message: typeof message === "string" ? message : code,
    data: { params: {}, requestId },
  };
}

/** Authorization-server metadata sits under the issuer's path (RFC 8414 §3). */
const DISCOVERY_PATHS = [
  "/.well-known/oauth-authorization-server/api/auth",
  "/.well-known/openid-configuration/api/auth",
  "/.well-known/oauth-protected-resource/api/mcp",
];

export function mountAuth(fastify: FastifyInstance, auth: Auth, baseUrl: string) {
  const handle = (request: FastifyRequest, reply: FastifyReply) =>
    // Same request context as the rest of the API: logs, queued emails and audit
    // events from auth flows carry the request id and the acting user.
    runWithContext(contextFor(request), async () => {
      const url = new URL(request.url, baseUrl);
      const headers = toHeaders(request);
      // better-auth rate-limits and records sessions by the first X-Forwarded-For entry,
      // which any client can write. Replace it with the address Fastify resolved through
      // TRUSTED_PROXIES, so only a trusted gateway can vouch for the client IP.
      headers.set("x-forwarded-for", request.ip);
      if (request.headers.cookie?.includes("session_token")) {
        const session = await auth.api.getSession({ headers });
        if (session) {
          updateContext({ userId: session.user.id });
        }
      }
      const response = await auth.handler(toWebRequest(request, url, headers));
      const answer = await fromWebResponse(reply, response);
      const error =
        answer && response.status >= 400
          ? authErrorBody(answer, response.status, request.id)
          : null;
      if (error) {
        reply.removeHeader("content-length");
        return reply.type("application/json").send(error);
      }
      return reply.send(answer);
    });

  fastify.register((scope, _options, done) => {
    rawBodies(scope);
    scope.route({ method: ["GET", "POST"], url: "/api/auth/*", handler: handle });
    for (const url of DISCOVERY_PATHS) {
      scope.route({ method: ["GET", "HEAD"], url, handler: handle });
    }
    done();
  });
}
