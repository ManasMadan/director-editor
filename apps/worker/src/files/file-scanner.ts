/**
 * Virus scanning for uploads. `ClamdScanner` streams the bytes to clamd (ClamAV's daemon)
 * with its INSTREAM command; clamd runs next to the worker (docker compose `files`
 * profile locally, a sidecar or service in Kubernetes) and keeps its signatures current.
 *
 * Seam: to use a scanning API instead (a cloud provider's malware scanning, VirusTotal
 * for enterprise), implement `FileScanner` and provide it in files.module.ts.
 */
import { connect } from "node:net";

export type ScanResult = { clean: true } | { clean: false; signature: string };

export interface FileScanner {
  scan(bytes: Buffer): Promise<ScanResult>;
}

export const FILE_SCANNER = Symbol("FILE_SCANNER");

const CHUNK = 64 * 1024;

export class ClamdScanner implements FileScanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 30_000,
  ) {}

  scan(bytes: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      let reply = "";
      let failure: Error | undefined;
      socket.setTimeout(this.timeoutMs, () => {
        failure = new Error("clamd timed out");
        socket.destroy();
      });
      socket.on("error", (error) => {
        failure ??= error;
      });
      socket.on("data", (data) => {
        reply += data.toString();
      });
      socket.on("close", () => {
        if (failure) {
          return reject(failure);
        }
        // "stream: OK", "stream: Eicar-Test-Signature FOUND", or "... ERROR".
        const answer = reply.replace(/\0/g, "").trim();
        if (answer.endsWith("OK")) {
          return resolve({ clean: true });
        }
        const found = /^stream: (.+) FOUND$/.exec(answer);
        if (found?.[1]) {
          return resolve({ clean: false, signature: found[1] });
        }
        reject(new Error(`clamd: ${answer || "no answer"}`));
      });
      socket.on("connect", () => {
        socket.write("zINSTREAM\0");
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          const chunk = bytes.subarray(offset, offset + CHUNK);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length);
          socket.write(size);
          socket.write(chunk);
        }
        socket.end(Buffer.alloc(4)); // a zero-length chunk ends the stream
      });
    });
  }
}

/** Development only (env.ts refuses it in production): accepts everything. */
export class NoScanner implements FileScanner {
  async scan(): Promise<ScanResult> {
    return { clean: true };
  }
}
