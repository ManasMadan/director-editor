import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ClamdScanner } from "./file-scanner";

let server: Server | undefined;
const sockets = new Set<Socket>();

function closeServer() {
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  const closing = server;
  server = undefined;
  return new Promise<void>((resolve) => (closing ? closing.close(() => resolve()) : resolve()));
}
afterEach(closeServer);

const INSTREAM = "zINSTREAM\0";

/**
 * The file an INSTREAM command sent (length-prefixed chunks, ended by an empty one), or
 * undefined while its last chunk hasn't arrived.
 */
function streamedFile(buffer: Buffer) {
  let offset = INSTREAM.length;
  const chunks: Buffer[] = [];
  while (offset + 4 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    if (size === 0) {
      return Buffer.concat(chunks);
    }
    if (offset + 4 + size > buffer.length) {
      return undefined;
    }
    chunks.push(buffer.subarray(offset + 4, offset + 4 + size));
    offset += 4 + size;
  }
  return undefined;
}

/**
 * A clamd stand-in: reads the INSTREAM framing, then answers with `answer(bytes)` (or,
 * for null, holds the connection open without answering). Half-open, like clamd: the
 * client ending its side doesn't close ours.
 */
async function fakeClamd(answer: (bytes: Buffer) => string | null) {
  server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on("data", (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length < INSTREAM.length) {
        return;
      }
      expect(buffer.subarray(0, INSTREAM.length).toString()).toBe(INSTREAM);
      const streamed = streamedFile(buffer);
      if (!streamed) {
        return;
      }
      const reply = answer(streamed);
      if (reply !== null) {
        socket.end(`${reply}\0`);
      }
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return (server as Server).address() as AddressInfo;
}

describe("ClamdScanner", () => {
  it("streams the whole file in chunks and reports a clean result", async () => {
    let received = 0;
    const { port } = await fakeClamd((bytes) => {
      received = bytes.length;
      return "stream: OK";
    });
    const bytes = Buffer.alloc(200_000, 7); // several 64 KiB chunks
    await expect(new ClamdScanner("127.0.0.1", port).scan(bytes)).resolves.toEqual({ clean: true });
    expect(received).toBe(200_000);
  });

  it("reports the signature it found", async () => {
    const { port } = await fakeClamd(() => "stream: Eicar-Test-Signature FOUND");
    await expect(new ClamdScanner("127.0.0.1", port).scan(Buffer.from("x"))).resolves.toEqual({
      clean: false,
      signature: "Eicar-Test-Signature",
    });
  });

  it("fails on a clamd error, so the job retries", async () => {
    const { port } = await fakeClamd(() => "INSTREAM size limit exceeded. ERROR");
    await expect(new ClamdScanner("127.0.0.1", port).scan(Buffer.from("x"))).rejects.toThrow(
      /size limit exceeded/,
    );
  });

  it("fails when clamd hangs up without an answer", async () => {
    const { port } = await fakeClamd(() => "");
    await expect(new ClamdScanner("127.0.0.1", port).scan(Buffer.from("x"))).rejects.toThrow(
      "clamd: no answer",
    );
  });

  it("fails when clamd doesn't answer in time", async () => {
    const { port } = await fakeClamd(() => null);
    await expect(new ClamdScanner("127.0.0.1", port, 200).scan(Buffer.from("x"))).rejects.toThrow(
      /timed out/,
    );
  });

  it("fails when clamd isn't there", async () => {
    await expect(new ClamdScanner("127.0.0.1", 1).scan(Buffer.from("x"))).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });
});
