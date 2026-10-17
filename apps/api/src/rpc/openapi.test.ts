import { describe, expect, it } from "vitest";
import { dropBodiesNeverSent, openApiDocument } from "./openapi";

describe("the REST document", () => {
  it("says every operation takes a signed-in session, and documents its JSON body", async () => {
    const spec = await openApiDocument({ version: "1", serverUrl: "/api/v1" });
    expect(spec.info.title).toBe("Director API");
    expect(spec.security).toEqual([{ session: [] }]);
    expect(spec.paths?.["/me"]?.get?.responses?.["200"]).toHaveProperty([
      "content",
      "application/json",
    ]);
    // Alongside the contract's own shared schemas.
    expect(spec.components?.schemas).toHaveProperty("ErrorData");
  });

  it("drops the body of a response that never has one, and leaves the rest alone", () => {
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
});
