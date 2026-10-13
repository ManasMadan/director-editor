import { createServer, type Server } from "node:http";
import { AiServiceError, createAiClient } from "@repo/ai-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// An AI service that takes the request and never answers: a stuck peer.
let server: Server;
let baseUrl: string;
beforeAll(async () => {
  server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("an assistant answer", () => {
  it("gives up on a service that never answers, and says the service is unavailable", async () => {
    const client = createAiClient({ baseUrl, secret: "s".repeat(32), answerTimeoutMs: 300 });
    const started = Date.now();
    const error = await client
      .answer({ userId: "u", orgId: "o", requestId: undefined }, "Hello?")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiServiceError);
    expect((error as AiServiceError).code).toBe("UPSTREAM_UNAVAILABLE");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
