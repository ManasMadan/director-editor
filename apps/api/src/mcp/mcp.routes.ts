/**
 * POST /api/mcp: the api's MCP server (Streamable HTTP, stateless: every request stands
 * alone, so any replica can answer and nothing is kept between requests).
 *
 * Each request needs an access token from this service's OAuth server for this MCP
 * resource (see auth.ts). Without one, or with one that's expired, revoked or for
 * something else, the answer is 401 with a WWW-Authenticate challenge pointing at the
 * protected-resource metadata (RFC 9728), which is how MCP clients find where to sign
 * the user in. Calls are limited per app and user.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { MCP_PATH, mcpResource } from "@repo/contracts/mcp";
import type { Locale } from "@repo/i18n";
import {
  type AppError,
  createRateLimiter,
  type Redis,
  rawBodies,
  runWithContext,
  updateContext,
} from "@repo/nest-common";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { contextFor, fromWebResponse, toWebRequest } from "../http-context";
import { createMcpServer, type McpServerDependencies } from "./mcp.server";
import type { TokenVerifierOptions } from "./mcp.tokens";
import { createTokenVerifier } from "./mcp.tokens";

export interface McpRouteOptions {
  /** The site's public origin (BETTER_AUTH_URL): the resource and issuer live there. */
  siteUrl: string;
  keys: TokenVerifierOptions["keys"];
  grantActive: TokenVerifierOptions["grantActive"];
  redis: Redis;
  server: Omit<McpServerDependencies, "describeError">;
  describeError: (error: AppError, locale: Locale) => Promise<string>;
}

/** Tool calls per app and user per minute. */
const CALLS_PER_MINUTE = 60;

/** Answers one request for a verified caller, with an MCP server of its own (stateless). */
async function answer(
  request: FastifyRequest,
  reply: FastifyReply,
  caller: Parameters<typeof createMcpServer>[0],
  options: McpRouteOptions,
) {
  const locale = contextFor(request).locale;
  const server = createMcpServer(caller, {
    ...options.server,
    describeError: (error) => options.describeError(error, locale),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(
      toWebRequest(request, new URL(request.url, options.siteUrl)),
      {
        authInfo: {
          token: caller.token,
          clientId: caller.clientId,
          scopes: [...caller.scopes],
          resource: new URL(mcpResource(options.siteUrl, MCP_PATH)),
        },
      },
    );
    return reply.send(await fromWebResponse(reply, response));
  } finally {
    await server.close();
  }
}

export function mountMcp(fastify: FastifyInstance, options: McpRouteOptions) {
  const resource = mcpResource(options.siteUrl, MCP_PATH);
  const metadataUrl = `${options.siteUrl.replace(/\/+$/, "")}/.well-known/oauth-protected-resource${MCP_PATH}`;
  const verify = createTokenVerifier({
    keys: options.keys,
    issuer: `${options.siteUrl.replace(/\/+$/, "")}/api/auth`,
    audience: resource,
    grantActive: options.grantActive,
  });
  const limiter = createRateLimiter(options.redis, {
    name: "mcp",
    points: CALLS_PER_MINUTE,
    windowSeconds: 60,
  });

  function challenge(reply: FastifyReply, description?: string) {
    const error = description ? `error="invalid_token", error_description="${description}", ` : "";
    return reply
      .status(401)
      .header("www-authenticate", `Bearer ${error}resource_metadata="${metadataUrl}"`)
      .send({ error: description ? "invalid_token" : "unauthorized" });
  }

  const handle = (request: FastifyRequest, reply: FastifyReply) =>
    runWithContext(contextFor(request), async () => {
      const header = request.headers.authorization;
      const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
      if (!token) {
        return challenge(reply);
      }
      const verified = await verify(token);
      if (!verified.ok) {
        return challenge(reply, verified.description);
      }
      const { caller } = verified;
      updateContext({ userId: caller.userId, orgId: caller.orgId });

      const limit = await limiter.consume(`${caller.clientId}:${caller.userId}`);
      if (!limit.allowed) {
        return reply
          .status(429)
          .header("retry-after", String(limit.retryAfterSeconds))
          .send({ error: "rate_limited" });
      }

      return answer(request, reply, caller, options);
    });

  fastify.register((scope, _options, done) => {
    // The transport reads the JSON-RPC body itself, exactly as sent.
    rawBodies(scope);
    scope.route({ method: ["GET", "POST", "DELETE"], url: MCP_PATH, handler: handle });
    done();
  });
}
