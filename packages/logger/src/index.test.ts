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
});
