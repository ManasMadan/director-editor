import { oc } from "@orpc/contract";
import { webhookEvents } from "@repo/contracts/events";
import { describe, expect, it } from "vitest";
import { dropBodiesNeverSent, markApiKeyOperations, openApiDocument } from "./openapi";

describe("the REST document", () => {
  it("says which operations take an API key, and with which scope", async () => {
    const spec = await openApiDocument({ version: "1", serverUrl: "/api/v1" });
    expect(spec.paths?.["/todos"]?.get).toMatchObject({
      security: [{ session: [] }, { apiKey: [] }],
      description: "API keys need the `todos:read` scope.",
    });
    expect(spec.paths?.["/me"]?.get?.security).toEqual([{ session: [] }]);
  });

  it("adds the scope to an operation's own description, and skips what it doesn't document", () => {
    const router = {
      described: oc.route({ method: "GET", path: "/a" }).meta({ apiKeyScope: "todos:read" }),
      undocumented: oc.route({ method: "GET", path: "/missing" }),
      unrouted: oc.meta({}),
      version: "not a procedure",
    };
    const spec = { openapi: "3.1.1", info: { title: "t", version: "1" } };
    const paths = { "/a": { get: { description: "Lists things." } } };
    markApiKeyOperations({ ...spec, paths } as never, router);
    expect(paths["/a"].get).toEqual({
      description: "Lists things.\n\nAPI keys need the `todos:read` scope.",
      security: [{ session: [] }, { apiKey: [] }],
    });
  });

  it("documents no body for a procedure that answers none, and keeps the others'", async () => {
    const spec = await openApiDocument({ version: "1", serverUrl: "/api/v1" });
    expect(spec.paths?.["/todos/{id}"]?.delete?.responses?.["204"]).toEqual({ description: "OK" });
    expect(spec.paths?.["/notifications/read-all"]?.post?.responses?.["200"]).toEqual({
      description: "OK",
    });
    expect(spec.paths?.["/todos"]?.post?.responses?.["201"]).toHaveProperty([
      "content",
      "application/json",
    ]);
  });

  it("leaves alone what isn't a body that never comes", () => {
    const never = { anyOf: [{ not: {} }, { not: {} }] };
    const paths = {
      "/a": {
        get: {
          responses: {
            "200": { description: "OK", content: { "application/json": { schema: never } } },
          },
        },
        post: { responses: { "200": { $ref: "#/components/responses/Shared" } } },
        put: { responses: { "200": { description: "OK", content: { "text/event-stream": {} } } } },
        patch: {},
      },
    };
    const spec = { openapi: "3.1.1", info: { title: "t", version: "1" } };
    dropBodiesNeverSent(spec as never);
    dropBodiesNeverSent({ ...spec, paths } as never);
    expect(paths["/a"]).toEqual({
      get: { responses: { "200": { description: "OK" } } },
      post: { responses: { "200": { $ref: "#/components/responses/Shared" } } },
      put: { responses: { "200": { description: "OK", content: { "text/event-stream": {} } } } },
      patch: {},
    });
  });

  it("describes the body of every event customers can subscribe to", async () => {
    const spec = await openApiDocument({ version: "1.0.0", serverUrl: "http://localhost" });
    expect(Object.keys(spec.webhooks ?? {}).sort()).toEqual([...webhookEvents].sort());
    expect(spec.webhooks?.["todo.created.v1"]).toMatchObject({
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/webhook.todo.created.v1" },
            },
          },
        },
      },
    });
    expect(spec.components?.schemas?.["webhook.todo.created.v1"]).toMatchObject({
      properties: { type: { const: "todo.created.v1" }, data: { required: ["todoId", "title"] } },
      required: ["type", "timestamp", "data"],
    });
    // Alongside the contract's own shared schemas, not instead of them.
    expect(spec.components?.schemas).toHaveProperty("ErrorData");
  });
});
