import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3Storage } from "./storage";

// A server that accepts connections and never answers: a stuck peer.
let server: Server;
let port: number;
const sockets: Socket[] = [];
beforeAll(async () => {
  server = createServer((socket) => void sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(() => {
  for (const socket of sockets) {
    socket.destroy();
  }
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("object storage", () => {
  it("gives up on a server that stops answering, instead of waiting forever", async () => {
    const storage = new S3Storage({
      bucket: "b",
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${port}`,
      forcePathStyle: true,
      accessKeyId: "k",
      secretAccessKey: "s",
      timeoutMs: 300,
    });
    const started = Date.now();
    await expect(storage.head("key")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
