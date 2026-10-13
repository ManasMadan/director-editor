import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FcmTransport, tokenIsDead } from "./fcm";

const invalidArgument = (field: string) =>
  JSON.stringify({
    error: { status: "INVALID_ARGUMENT", details: [{ fieldViolations: [{ field }] }] },
  });

describe("an FCM error", () => {
  it("means the token is dead when it's unregistered or malformed", () => {
    expect(tokenIsDead(404, "{}")).toBe(true);
    expect(tokenIsDead(400, '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}')).toBe(true);
    expect(tokenIsDead(400, invalidArgument("message.token"))).toBe(true);
  });

  it("doesn't when the fault is our message's, or the answer isn't one we know", () => {
    expect(tokenIsDead(400, invalidArgument("message.notification.title"))).toBe(false);
    expect(tokenIsDead(500, '{"error":{"status":"INTERNAL"}}')).toBe(false);
    expect(tokenIsDead(502, "<html>bad gateway</html>")).toBe(false);
    expect(tokenIsDead(400, '{"error":{"status":"INVALID_ARGUMENT"}}')).toBe(false);
    expect(tokenIsDead(400, '{"error":{"status":"INVALID_ARGUMENT","details":[{}]}}')).toBe(false);
  });
});

describe("FcmTransport", () => {
  afterEach(() => vi.restoreAllMocks());

  it("talks to Google's endpoints unless told otherwise", async () => {
    // Google can't be reached from a test: fetch answers for it, and records where it went.
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      calls.push(String(input));
      return String(input).endsWith("/token")
        ? Response.json({ access_token: "t", expires_in: 3600 })
        : Response.json({ name: "projects/p/messages/1" });
    });
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const fcm = new FcmTransport({
      projectId: "p",
      clientEmail: "push@p.iam.gserviceaccount.com",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    });
    expect(await fcm.send("token", { title: "t", body: "b" })).toEqual({
      ok: true,
      providerMessageId: "projects/p/messages/1",
    });
    expect(calls).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://fcm.googleapis.com/v1/projects/p/messages:send",
    ]);
  });
});
