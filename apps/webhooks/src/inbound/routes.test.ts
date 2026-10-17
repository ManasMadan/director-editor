/**
 * What the inbound routes answer before they touch the database: off without their
 * secret, and a request that can't be verified. Verified events are
 * test/webhooks.integration.test.ts.
 */
import type { Database } from "@repo/nest-common";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { mountStalwart } from "./stalwart.routes";

// Never reached by these requests.
const database = {} as Database;

async function post(
  mount: (app: ReturnType<typeof Fastify>) => void,
  url: string,
  request: { headers?: Record<string, string>; body?: string } = {},
) {
  const app = Fastify();
  mount(app);
  const response = await app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...request.headers },
    body: request.body ?? "{}",
  });
  await app.close();
  return { status: response.statusCode, code: response.json().code as string };
}

describe("inbound routes", () => {
  it("don't exist without their provider's secret", async () => {
    expect(
      await post((app) => mountStalwart(app, database, undefined), "/webhooks/stalwart"),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
  });

  it("refuse a Stalwart request whose body isn't JSON", async () => {
    const stalwart = (app: ReturnType<typeof Fastify>) =>
      mountStalwart(app, database, ["k".repeat(32)]);
    expect(
      await post(stalwart, "/webhooks/stalwart", {
        headers: { "x-signature": "abc", "content-type": "text/plain" },
        body: "hello",
      }),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
  });
});
