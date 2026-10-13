/**
 * What every HTTP entry point (oRPC, REST, better-auth) knows about a request before any
 * handler runs: its id, the client's language and app version. Handlers run inside
 * `runWithContext(contextFor(request), ...)`; the user and organization are added once
 * the session is resolved.
 */
import { type Locale, negotiateLocale } from "@repo/i18n";
import type { RequestContext } from "@repo/nest-common";
import type { FastifyReply, FastifyRequest } from "fastify";

export function contextFor(request: FastifyRequest): RequestContext & { locale: Locale } {
  const header = (name: string) => {
    const value = request.headers[name];
    return typeof value === "string" ? value : undefined;
  };
  return {
    requestId: request.id,
    locale: negotiateLocale(header("x-locale") ?? header("accept-language")),
    clientVersion: header("x-app-version"),
  };
}

/** Fastify's parsed headers as a Web Headers object (for better-auth and oRPC). */
export function toHeaders(request: FastifyRequest) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value !== undefined) {
      headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
    }
  }
  return headers;
}

/**
 * The Fastify request as a Web Request, for handlers written against the Fetch API
 * (better-auth, the MCP transport). The body is the raw one `rawBodies` keeps.
 */
export function toWebRequest(request: FastifyRequest, url: URL, headers = toHeaders(request)) {
  const body = Buffer.isBuffer(request.body) ? new Uint8Array(request.body) : undefined;
  return new Request(url, { method: request.method, headers, ...(body && { body }) });
}

/**
 * Copies a Web Response's status and headers onto the reply and returns its body. Each
 * Set-Cookie stays its own header: joined into one, as iterating the headers gives them,
 * browsers would read a single broken cookie.
 */
export async function fromWebResponse(reply: FastifyReply, response: Response) {
  reply.status(response.status);
  for (const [key, value] of response.headers) {
    if (key !== "set-cookie") {
      reply.header(key, value);
    }
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) {
    reply.header("set-cookie", cookies);
  }
  return response.body ? Buffer.from(await response.arrayBuffer()) : null;
}
