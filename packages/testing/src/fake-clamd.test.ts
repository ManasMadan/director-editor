import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { answer, clamdFor, serve, startFakeClamd } from "./fake-clamd";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/** INSTREAM, as the worker sends it: the command, length-prefixed chunks, a zero length. */
function stream(...chunks: string[]) {
  const parts = [Buffer.from("zINSTREAM\0")];
  for (const chunk of chunks) {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(Buffer.byteLength(chunk));
    parts.push(size, Buffer.from(chunk));
  }
  parts.push(Buffer.alloc(4));
  return Buffer.concat(parts);
}

/** Sends `bytes` to the clamd at `url` and reads its answer. */
function scan(url: string, bytes: Buffer) {
  const { hostname, port } = new URL(url);
  return new Promise<string>((resolve, reject) => {
    let reply = "";
    const socket = connect({ host: hostname, port: Number(port) }, () => socket.end(bytes));
    socket.on("data", (data) => {
      reply += data.toString();
    });
    socket.on("close", () => resolve(reply));
    socket.on("error", reject);
  });
}

describe("the clamd stand-in", () => {
  it("answers OK for clean bytes and FOUND for the EICAR test file, across chunks", () => {
    expect(answer(stream("hello", " world"))).toBe("stream: OK\0");
    const half = EICAR.length / 2;
    expect(answer(stream(EICAR.slice(0, half), EICAR.slice(half)))).toBe(
      "stream: Eicar-Test-Signature FOUND\0",
    );
  });

  it("waits for the rest of a stream, and refuses another command", () => {
    const whole = stream("hello");
    expect(answer(whole.subarray(0, 5))).toBeNull();
    expect(answer(whole.subarray(0, 16))).toBeNull();
    expect(answer(whole.subarray(0, whole.length - 4))).toBeNull();
    expect(answer(Buffer.from("zPING\0zPING\0"))).toBe("UNKNOWN COMMAND\0");
  });

  it("answers once a stream sent in pieces is complete", () => {
    const sent: string[] = [];
    let onData: (data: Buffer) => void = () => undefined;
    serve({
      on: (_event: string, listener: (data: Buffer) => void) => {
        onData = listener;
      },
      end: (reply: string) => sent.push(reply),
    } as never);
    const whole = stream("hello");
    onData(whole.subarray(0, 12));
    expect(sent).toEqual([]);
    onData(whole.subarray(12));
    expect(sent).toEqual(["stream: OK\0"]);
  });

  it("scans over its socket, as clamd does", async () => {
    const clamd = await startFakeClamd();
    try {
      expect(await scan(clamd.url, stream(EICAR))).toBe("stream: Eicar-Test-Signature FOUND\0");
      expect(await scan(clamd.url, stream("clean"))).toBe("stream: OK\0");
    } finally {
      await clamd.close();
    }
  });

  it("is used only where no clamd answers, and never in CI", async () => {
    const real = await startFakeClamd();
    try {
      const found = await clamdFor(real.url, {});
      expect(found.url).toBe(real.url);
      await found.close();
    } finally {
      await real.close();
    }
    const missing = "tcp://127.0.0.1:1";
    const standIn = await clamdFor(missing, {});
    expect(standIn.url).not.toBe(missing);
    await standIn.close();
    await expect(clamdFor(missing, { CI: "true" })).rejects.toThrow("CI runs the real ClamAV");
  });
});
