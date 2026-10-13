/**
 * A stand-in for clamd (ClamAV's daemon) on machines that can't run ClamAV, which needs
 * more memory than a small Docker VM has next to the core services. It speaks the
 * INSTREAM command the worker sends and finds the EICAR test file, which is what the
 * suites scan for. CI runs the real ClamAV, so `clamdFor` never uses this there.
 *
 *   const clamd = await clamdFor(process.env.CLAMAV_URL ?? "tcp://localhost:53310");
 *   process.env.CLAMAV_URL = clamd.url;   // ... then `await clamd.close()`
 */
import { connect, createServer, type Socket } from "node:net";
import * as z from "zod";

/** What every antivirus, ClamAV included, reports in the EICAR test file. */
const EICAR = "EICAR-STANDARD-ANTIVIRUS-TEST-FILE";
const COMMAND = "zINSTREAM\0";

export interface Clamd {
  url: string;
  close(): Promise<void>;
}

/** clamd's answer to one connection's bytes, or null while the stream isn't over. */
export function answer(received: Buffer): string | null {
  if (received.length < COMMAND.length) {
    return null;
  }
  if (received.subarray(0, COMMAND.length).toString() !== COMMAND) {
    return "UNKNOWN COMMAND\0";
  }
  const chunks: Buffer[] = [];
  let offset = COMMAND.length;
  while (offset + 4 <= received.length) {
    const size = received.readUInt32BE(offset);
    if (size === 0) {
      const scanned = Buffer.concat(chunks).toString("latin1");
      return scanned.includes(EICAR) ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0";
    }
    if (offset + 4 + size > received.length) {
      return null;
    }
    chunks.push(received.subarray(offset + 4, offset + 4 + size));
    offset += 4 + size;
  }
  return null;
}

/** One connection: its bytes gathered until the stream is over, then the answer. */
export function serve(socket: Pick<Socket, "on" | "end">) {
  let received = Buffer.alloc(0);
  socket.on("data", (data: Buffer) => {
    received = Buffer.concat([received, data]);
    const reply = answer(received);
    if (reply !== null) {
      socket.end(reply);
    }
  });
}

/** Starts the stand-in on a free local port. */
export async function startFakeClamd(): Promise<Clamd> {
  const server = createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = z.object({ port: z.number() }).parse(server.address());
  return {
    url: `tcp://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Whether something accepts connections at `url` (tcp://host:port, a local one). */
function answers(url: string) {
  const { hostname, port } = new URL(url);
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: hostname, port: Number(port) });
    socket.on("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

/**
 * The clamd to test against: the one at `url` when it answers, else, outside CI, the
 * stand-in. In CI a missing ClamAV is a broken job, not something to cover up.
 */
export async function clamdFor(url: string, env = process.env): Promise<Clamd> {
  // A clamd that's already running belongs to whoever started it: nothing to close.
  if (await answers(url)) {
    return { url, close: () => Promise.resolve() };
  }
  if (env.CI) {
    throw new Error(`clamd isn't answering at ${url}; CI runs the real ClamAV.`);
  }
  return startFakeClamd();
}
