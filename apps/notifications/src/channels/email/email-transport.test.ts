import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SmtpTransport } from "./email-transport";

// A mail server that accepts the connection and never greets: a stuck peer.
let server: Server;
let port: number;
beforeAll(async () => {
  server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("SMTP delivery", () => {
  it("gives up on a server that never answers, instead of holding the job for minutes", async () => {
    const transport = new SmtpTransport(`smtp://127.0.0.1:${port}`, 300);
    const started = Date.now();
    await expect(
      transport.send({
        from: "a@test.dev",
        to: "b@test.dev",
        subject: "s",
        html: "<p>h</p>",
        text: "t",
        headers: {},
        idempotencyKey: "k",
      }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
