/**
 * Serves the API on the Fastify instance, from one router:
 *
 *   /rpc/*                 oRPC protocol, used by web and mobile (keeps Dates and other
 *                          rich types, streams subscriptions)
 *   /api/v1/*              REST, for third parties and API keys; same procedures
 *   /api/v1/openapi.json   OpenAPI 3.1 document generated from the contract
 *   /docs                  interactive API reference (not in production)
 *
 * Every request runs inside a request context (request id, locale, client version) so
 * logs, queued jobs and outbox events all carry the same request id.
 *
 * Why oRPC's own Fastify handlers and not the `@orpc/nest` adapter: the adapter only
 * speaks the OpenAPI codec, so the web and mobile clients' RPCLink got 404s; it crashed
 * reading request headers unless every call passed a context; and Nest interceptors on
 * its handlers were silently skipped. Mounting both handlers here keeps one pipeline
 * (procedures.ts) for both protocols, with services still resolved from Nest's container.
 */

import { OpenAPIHandler } from "@orpc/openapi/fastify";
import { RPCHandler } from "@orpc/server/fastify";
import { API_KEY_HEADER } from "@repo/contracts/api";
import { runWithContext, sendError } from "@repo/nest-common";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { contextFor, toHeaders } from "../http-context";
import { openApiDocument } from "./openapi";
import { type LogError, toContractError } from "./procedures";
import type { AppRouter } from "./router";

export interface MountOptions {
  logError: LogError;
  publicUrl: string;
  release: string;
  exposeDocs: boolean;
  /**
   * Refuse to answer a code the procedure's contract doesn't declare (a bug in the
   * contract): on everywhere but production, so tests and development catch it.
   */
  strictErrors: boolean;
}

/** An interceptor that converts every error to the contract's shape, for both protocols. */
function contractErrors({ logError, strictErrors }: MountOptions) {
  return async ({
    next,
    path,
    procedure,
  }: {
    next: () => Promise<unknown>;
    path: readonly string[];
    procedure: { "~orpc": { errorMap: Record<string, unknown> } };
  }) => {
    try {
      return await next();
    } catch (error) {
      const mapped = toContractError(error, logError);
      if (strictErrors && !(mapped.code in procedure["~orpc"].errorMap)) {
        throw toContractError(
          new Error(`${path.join(".")} threw ${mapped.code}, which its contract doesn't declare`, {
            cause: error,
          }),
          logError,
        );
      }
      throw mapped;
    }
  };
}

/** A Fastify handler that runs one oRPC handler under `prefix`, in the request's context. */
function serve(handler: RPCHandler<object> | OpenAPIHandler<object>, prefix: `/${string}`) {
  return async function handle(
    request: FastifyRequest,
    reply: Parameters<RPCHandler<object>["handle"]>[1],
  ) {
    await runWithContext(contextFor(request), async () => {
      const { matched } = await handler.handle(request, reply, {
        prefix,
        context: { headers: toHeaders(request) },
      });
      if (!matched) {
        await sendError(reply, "NOT_FOUND");
      }
    });
  };
}

/** The interactive API reference, on the generated document. */
function mountDocs(fastify: FastifyInstance) {
  fastify.get("/docs", async (_request, reply) =>
    reply
      .type("text/html")
      .send(`<!doctype html><html><head><title>API reference</title><meta charset="utf-8"/></head>
<body><script id="api-reference" data-url="/api/v1/openapi.json"></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1"></script></body></html>`),
  );
}

export async function mountRpc(fastify: FastifyInstance, router: AppRouter, options: MountOptions) {
  const mapErrors = contractErrors(options);
  const rpc = new RPCHandler(router, {
    clientInterceptors: [mapErrors],
    // Keeps idle event streams alive through proxies (Cloudflare closes idle ones at 100s).
    eventIteratorKeepAliveInterval: 20_000,
  });
  const rest = new OpenAPIHandler(router, {
    clientInterceptors: [mapErrors],
    eventIteratorKeepAliveInterval: 20_000,
  });

  // Event streams (realtime) must reach the client as they're written. Any compressing
  // or buffering hop (Next's dev proxy, nginx-style gateways, CDNs) would hold them
  // until the stream ends; these headers tell every one of them not to.
  fastify.addHook("onSend", async (_request, reply, payload) => {
    const type = reply.getHeader("content-type");
    if (typeof type === "string" && type.startsWith("text/event-stream")) {
      reply.header("cache-control", "no-cache, no-transform");
      reply.header("x-accel-buffering", "no");
    }
    return payload;
  });

  // Both protocols speak JSON only (files go straight to storage through presigned URLs),
  // parsed by Fastify under the server's bodyLimit before any procedure or auth check
  // runs: anything else is refused (415), and an oversized body too (413). oRPC would
  // otherwise read the raw stream itself, with no limit, for any other content type.
  fastify.register((scope, _options, done) => {
    // REST callers authenticate with an API key; a 401 says how, as HTTP expects.
    scope.addHook("onSend", async (request, reply, payload) => {
      if (reply.statusCode === 401 && request.url.startsWith("/api/v1/")) {
        reply.header("www-authenticate", `ApiKey header="${API_KEY_HEADER}"`);
      }
      return payload;
    });
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      scope.getDefaultJsonParser("error", "error"),
    );
    scope.all("/rpc/*", serve(rpc, "/rpc"));
    scope.all("/api/v1/*", serve(rest, "/api/v1"));
    done();
  });

  const spec = await openApiDocument({
    version: options.release,
    serverUrl: new URL("/api/v1", options.publicUrl).toString(),
  });
  fastify.get("/api/v1/openapi.json", async () => spec);

  if (options.exposeDocs) {
    mountDocs(fastify);
  }
}
