import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AppRouter } from "./router";
import { mountRpc } from "./rpc.routes";

describe("the API reference page", () => {
  it("isn't served in production; the OpenAPI document still is", async () => {
    const fastify = Fastify();
    await mountRpc(fastify, {} as AppRouter, {
      logError: () => undefined,
      publicUrl: "https://api.example.com",
      release: "1.0.0",
      exposeDocs: false,
      strictErrors: false,
    });
    expect((await fastify.inject("/docs")).statusCode).toBe(404);
    const spec = await fastify.inject("/api/v1/openapi.json");
    expect(spec.json()).toMatchObject({ servers: [{ url: "https://api.example.com/api/v1" }] });
    await fastify.close();
  });
});
