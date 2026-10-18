import type { IncomingMessage } from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  actorContext,
  contextFor,
  fromWebResponse,
  toHeaders,
  toWebRequest,
  upgradeContext,
} from "./http-context";

const request = (headers: FastifyRequest["headers"]) =>
  ({ id: "req-1", ip: "203.0.113.9", headers }) as FastifyRequest;

describe("a request's context", () => {
  it("takes the language from x-locale, then Accept-Language, else English", () => {
    expect(contextFor(request({ "x-locale": "en", "accept-language": "fr" }))).toEqual({
      requestId: "req-1",
      locale: "en",
      clientVersion: undefined,
      ip: "203.0.113.9",
      userAgent: undefined,
    });
    expect(contextFor(request({ "accept-language": "en-GB", "x-app-version": "2.0.0" }))).toEqual({
      requestId: "req-1",
      locale: "en",
      clientVersion: "2.0.0",
      ip: "203.0.113.9",
      userAgent: undefined,
    });
    // A language the app doesn't have.
    expect(contextFor(request({ "x-locale": "es", "accept-language": "es-MX" })).locale).toBe("en");
  });

  it("knows where the request came from: the resolved address and the user agent", () => {
    expect(contextFor(request({ "user-agent": "Mozilla/5.0" }))).toMatchObject({
      ip: "203.0.113.9",
      userAgent: "Mozilla/5.0",
    });
  });
});

describe("a WebSocket upgrade's context", () => {
  it("has its own request id, the address a trusted proxy forwarded, and the user agent", () => {
    const upgrade = {
      headers: { "x-forwarded-for": "198.51.100.7", "user-agent": "Mozilla/5.0" },
      socket: { remoteAddress: "127.0.0.1" },
      connection: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;
    expect(upgradeContext(["loopback"])(upgrade)).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      ip: "198.51.100.7",
      userAgent: "Mozilla/5.0",
    });
  });
});

describe("a session's actor", () => {
  it("is the user's id, email and name, and whether it's the demo account", () => {
    const user = { id: "u-1", email: "ada@example.com", name: "Ada" };
    expect(actorContext({ ...user, demo: true })).toEqual({
      userId: "u-1",
      email: "ada@example.com",
      name: "Ada",
      demo: true,
    });
    expect(actorContext({ ...user, demo: null }).demo).toBe(false);
  });
});

describe("a request's headers", () => {
  it("become Web headers, a repeated one joined and a missing one left out", () => {
    const headers = toHeaders(
      request({ host: "api.test", "set-cookie": ["a=1", "b=2"], "x-empty": undefined }),
    );
    expect([...headers]).toEqual([
      ["host", "api.test"],
      ["set-cookie", "a=1, b=2"],
    ]);
  });
});

describe("the bridge to Fetch API handlers", () => {
  it("passes the method, headers and raw body on as a Web Request", async () => {
    const fastify = Object.assign(request({ "content-type": "application/json" }), {
      method: "POST",
      body: Buffer.from('{"a":1}'),
    });
    const web = toWebRequest(fastify, new URL("https://api.test/api/auth/sign-in"));
    expect(web.method).toBe("POST");
    expect(web.headers.get("content-type")).toBe("application/json");
    expect(await web.text()).toBe('{"a":1}');
    const get = toWebRequest(
      Object.assign(request({}), { method: "GET" }),
      new URL("https://api.test/"),
    );
    expect(get.body).toBeNull();
  });

  it("copies the response back, each Set-Cookie its own header", async () => {
    const headers = new Headers({ "content-type": "text/plain" });
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");
    const sent: [string, unknown][] = [];
    let status = 0;
    const reply = {
      status: (code: number) => {
        status = code;
        return reply;
      },
      header: (key: string, value: unknown) => {
        sent.push([key, value]);
        return reply;
      },
    } as unknown as FastifyReply;
    const body = await fromWebResponse(reply, new Response("hi", { status: 201, headers }));
    expect(status).toBe(201);
    expect(body?.toString()).toBe("hi");
    expect(sent).toEqual([
      ["content-type", "text/plain"],
      ["set-cookie", ["a=1; Path=/", "b=2; Path=/"]],
    ]);
    expect(await fromWebResponse(reply, new Response(null, { status: 204 }))).toBeNull();
  });
});
