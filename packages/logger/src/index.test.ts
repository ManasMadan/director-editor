import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { createLogger, loggerOptions, scrub } from "./index";

describe("scrub", () => {
  it("censors sensitive keys at any depth and keeps everything else", () => {
    expect(
      scrub({
        job: { data: { data: { otp: "123456", purpose: "sign-in" } } },
        user: { Password: "x", name: "Ada" },
      }),
    ).toEqual({
      job: { data: { data: { otp: "[redacted]", purpose: "sign-in" } } },
      user: { Password: "[redacted]", name: "Ada" },
    });
  });

  it("scrubs inside arrays, keeps errors whole and stops at a depth limit", () => {
    const error = new Error("boom");
    let deep: unknown = { token: "deepest" };
    for (let i = 0; i < 9; i++) {
      deep = { inner: deep };
    }
    const out = scrub({ items: [{ token: "t" }, 1], error, deep }) as Record<string, unknown>;
    expect(out.items).toEqual([{ token: "[redacted]" }, 1]);
    expect(out.error).toBe(error);
    expect(JSON.stringify(out.deep)).toContain("deepest");
  });
});

describe("loggerOptions", () => {
  it("pretty-prints only when asked", () => {
    expect(loggerOptions({ service: "api" })).not.toHaveProperty("transport");
    expect(loggerOptions({ service: "api", pretty: true }).transport).toMatchObject({
      target: "pino-pretty",
    });
  });

  it("builds a logger at the level asked for", () => {
    expect(createLogger({ service: "api", level: "warn" }).level).toBe("warn");
  });
});

describe("logger", () => {
  it("never writes a nested secret to the output", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const log = pino(loggerOptions({ service: "test" }), sink);
    log.info(
      { job: { data: { data: { otp: "987654" } } }, req: { headers: { cookie: "session=abc" } } },
      "sent",
    );
    const line = lines.join("");
    expect(line).not.toContain("987654");
    expect(line).not.toContain("session=abc");
    expect(JSON.parse(line)).toMatchObject({ service: "test", level: "info", msg: "sent" });
  });

  // Every secret the activity logs could come near, logged the ways a mistake would log
  // it: none may reach the output, while who did what (email, address) still does.
  it("never writes a code, password, token, cookie, signature or request body", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const log = pino(loggerOptions({ service: "test" }), sink);
    const signed =
      "https://storage.example.com/takes/t1.webm?X-Amz-Credential=key&X-Amz-Signature=deadbeef";
    log.info(
      {
        activity: "auth.signed_in",
        actor: { email: "ada@example.com" },
        ip: "203.0.113.9",
        req: {
          headers: { authorization: "Bearer api-key-1", cookie: "session_token=abc" },
          body: { email: "ada@example.com", password: "hunter22" },
        },
        res: { headers: { "set-cookie": "session_token=def" } },
        body: { otp: "123456" },
        account: {
          accessToken: "ya29.access",
          refresh_token: "1//refresh",
          idToken: "eyJ.id",
          session_token: "sess-1",
          client_secret: "client-1",
        },
        sourceUrl: signed,
        err: { message: `couldn't fetch ${signed}` },
        gcs: "https://storage.googleapis.com/b/o?X-Goog-Signature=cafe&X-Goog-Expires=60",
      },
      "activity",
    );
    const line = lines.join("");
    for (const secret of [
      "api-key-1",
      "session_token=abc",
      "hunter22",
      "session_token=def",
      "123456",
      "ya29.access",
      "1//refresh",
      "eyJ.id",
      "sess-1",
      "client-1",
      "deadbeef",
      "X-Amz-Credential=key",
      "cafe",
    ]) {
      expect(line).not.toContain(secret);
    }
    expect(JSON.parse(line)).toMatchObject({
      actor: { email: "ada@example.com" },
      ip: "203.0.113.9",
      sourceUrl: "https://storage.example.com/takes/t1.webm?[redacted]",
      err: { message: "couldn't fetch https://storage.example.com/takes/t1.webm?[redacted]" },
    });
  });

  it("keeps a URL without a signature as it is", () => {
    expect(scrub({ url: "https://www.youtube.com/shorts/abc?feature=share" })).toEqual({
      url: "https://www.youtube.com/shorts/abc?feature=share",
    });
  });
});
