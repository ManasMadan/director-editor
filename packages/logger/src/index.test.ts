import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { createLogger, isSecretField, loggerOptions, scrub } from "./index";

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

  it("scrubs inside arrays and errors, and stops at a depth limit", () => {
    const error = new Error("boom");
    let deep: unknown = { token: "deepest" };
    for (let i = 0; i < 9; i++) {
      deep = { inner: deep };
    }
    const out = scrub({ items: [{ token: "t" }, 1], error, deep }) as Record<string, unknown>;
    expect(out.items).toEqual([{ token: "[redacted]" }, 1]);
    expect(out.error).toMatchObject({ type: "Error", message: "boom", stack: error.stack });
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
      "https://storage.example.com/takes/t1.webm?X-Amz-Date=20261018&X-Amz-Credential=AKIA1&X-Amz-Signature=deadbeef";
    const censored =
      "https://storage.example.com/takes/t1.webm?X-Amz-Date=20261018&X-Amz-Credential=[redacted]&X-Amz-Signature=[redacted]";
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
      "AKIA1",
      "cafe",
    ]) {
      expect(line).not.toContain(secret);
    }
    expect(JSON.parse(line)).toMatchObject({
      actor: { email: "ada@example.com" },
      ip: "203.0.113.9",
      sourceUrl: censored,
      err: { message: `couldn't fetch ${censored}` },
    });
  });

  it("keeps a URL without a signature as it is", () => {
    expect(scrub({ url: "https://www.youtube.com/shorts/abc?feature=share" })).toEqual({
      url: "https://www.youtube.com/shorts/abc?feature=share",
    });
  });

  it("censors a signed URL in a real Error and in the message, and keeps the stack", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const log = pino(loggerOptions({ service: "test" }), sink);
    const signed = "https://s.example.com/t.webm?X-Goog-Credential=gc-1&X-Goog-Signature=beef";
    const censored =
      "https://s.example.com/t.webm?X-Goog-Credential=[redacted]&X-Goog-Signature=[redacted]";
    const cause = new Error(`fetching ${signed} failed`);
    log.error({ err: new Error(`upload of ${signed} failed`, { cause }) }, "upload failed");
    log.warn({ error: cause }, `why? ${signed} answered 403`);
    const logged = z.object({
      msg: z.string(),
      err: z.unknown().optional(),
      error: z.object({ message: z.string() }).optional(),
    });
    const [failed, warned] = lines.map((line) => logged.parse(JSON.parse(line)));
    for (const line of lines) {
      expect(line).not.toContain("gc-1");
      expect(line).not.toContain("beef");
    }
    expect(failed?.err).toMatchObject({
      type: "Error",
      // pino adds the cause's message to the error's.
      message: `upload of ${censored} failed: fetching ${censored} failed`,
      stack: expect.stringContaining(`upload of ${censored} failed\n    at `),
    });
    expect(warned?.msg).toBe(`why? ${censored} answered 403`);
    expect(warned?.error?.message).toBe(`fetching ${censored} failed`);
  });
});

describe("a credential's name", () => {
  it.each([
    "password",
    "newPassword",
    "api_key",
    "apiKey",
    "X-Api-Key",
    "serviceSecret",
    "client-secret",
    "access_token",
    "sessionToken",
    "Authorization",
    "set-cookie",
    "otp",
    "AWS_CREDENTIALS",
    "backupCodes",
  ])("%s is censored, whatever its casing style", (name) => {
    expect(scrub({ [name]: "s3cr3t" })).toEqual({ [name]: "[redacted]" });
  });

  it.each(["inputTokens", "outputTokens", "email", "key", "signature"])(
    "%s only looks like one, and is kept",
    (name) => {
      expect(isSecretField(name)).toBe(false);
    },
  );

  it("is found in a query too, which keeps every other parameter", () => {
    expect(
      scrub("/cb?code=abc&state=s1&key=AIza1&token=t1&sig=x&X-Amz-Expires=60&access_token=a"),
    ).toBe(
      "/cb?code=[redacted]&state=s1&key=[redacted]&token=[redacted]&sig=[redacted]&X-Amz-Expires=60&access_token=[redacted]",
    );
  });

  it("finds a parameter after a stray separator, and gets through a long run of them at once", () => {
    expect(scrub("/cb?x?code=abc&&state=s1")).toBe("/cb?x?code=[redacted]&&state=s1");
    const separators = "?a".repeat(50_000);
    const started = performance.now();
    expect(scrub(separators)).toBe(separators);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
