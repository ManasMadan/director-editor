import { AppError } from "@repo/nest-common";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { NotificationsService } from "./notifications.service";
import { mountOneClickUnsubscribe } from "./unsubscribe.routes";

async function post(unsubscribe: () => Promise<unknown>) {
  const fastify = Fastify();
  mountOneClickUnsubscribe(fastify, { unsubscribe } as unknown as NotificationsService);
  const response = await fastify.inject({
    method: "POST",
    url: "/api/v1/notifications/unsubscribe?token=t",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "List-Unsubscribe=One-Click",
  });
  await fastify.close();
  return response;
}

describe("one-click unsubscribe", () => {
  it("says the link is invalid only when it is", async () => {
    const response = await post(async () => {
      throw new AppError("UNSUBSCRIBE_LINK_INVALID");
    });
    expect(response.statusCode).toBe(400);
  });

  it("doesn't pass off our own failure (the database down) as an invalid link", async () => {
    const response = await post(async () => {
      throw new Error("connection refused");
    });
    expect(response.statusCode).toBe(500);
  });
});
