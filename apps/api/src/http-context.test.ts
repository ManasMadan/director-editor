import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { contextFor, fromWebResponse, toHeaders, toWebRequest } from "./http-context";

const request = (headers: FastifyRequest["headers"]) =>
  ({ id: "req-1", headers }) as FastifyRequest;

describe("a request's context", () => {
  it("takes the language from x-locale first, then Accept-Language", () => {
    expect(contextFor(request({ "x-locale": "es", "accept-language": "en" }))).toEqual({
      requestId: "req-1",
      locale: "es",
      clientVersion: undefined,
    });
    expect(contextFor(request({ "accept-language": "es-MX", "x-app-version": "2.0.0" }))).toEqual({
      requestId: "req-1",
      locale: "es",
      clientVersion: "2.0.0",
    });
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
