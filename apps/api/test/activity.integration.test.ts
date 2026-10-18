/**
 * Activity lines, as the real API writes them to its log: who signed up and in (and how,
 * from where, with which browser), who failed to and why, every procedure call with its
 * caller, signing in with Google and letting Director upload to YouTube, and signing out.
 * The lines are read where pino writes them, after its redaction, so this also proves no
 * password or code reaches the log.
 */
import { YOUTUBE_UPLOAD_SCOPE } from "@repo/contracts/api";
import { startFakeGoogle } from "@repo/fake-google";
import { PinoLogger } from "@repo/nest-common";
import { symbols } from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import {
  createSession,
  googleConsent,
  type Harness,
  newEmail,
  newPassword,
  startApi,
  takeOtp,
} from "./harness";

let harness: Harness;
let google: Awaited<ReturnType<typeof startFakeGoogle>>;
const written: string[] = [];
let stream: { write(line: string): boolean };
let write: (line: string) => boolean;

beforeAll(async () => {
  google = await startFakeGoogle({ apiKey: "unused" });
  // Logs on, unlike the other suites: they are what this one reads.
  harness = await startApi(29, {
    LOG_LEVEL: "info",
    GOOGLE_CLIENT_ID: "director-test.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "director-test-secret",
  });
  // Where the API's logger writes (stdout): every line, as it leaves the process. Put
  // back by hand, not as a mock, so restoring the Google helper's mock leaves it.
  stream = Reflect.get(PinoLogger.root, symbols.streamSym) as typeof stream;
  write = stream.write.bind(stream);
  stream.write = (line: string) => {
    written.push(String(line));
    return true;
  };
});
afterAll(async () => {
  if (stream) {
    stream.write = write;
  }
  await harness?.close();
  await google?.close();
});
afterEach(() => {
  written.length = 0;
});

const line = z.looseObject({
  activity: z.string().optional(),
  actor: z.looseObject({}).optional(),
  target: z.looseObject({}).optional(),
});

/** The activity lines written so far, parsed. */
function activities() {
  return written
    .map((text) => line.parse(JSON.parse(text)))
    .filter((entry) => entry.activity !== undefined);
}

/** Waits for an activity line named `name` whose fields include `fields`. */
async function activity(name: string, fields: Record<string, unknown> = {}) {
  await vi.waitFor(() =>
    expect(activities()).toContainEqual(expect.objectContaining({ activity: name, ...fields })),
  );
  return activities().filter((entry) => entry.activity === name);
}

describe("activity lines", () => {
  it("say who signed up and signed in, how, from where, and with what", async () => {
    const session = createSession(harness);
    const email = newEmail();
    const password = newPassword();
    await session.auth("/sign-up/email", { email, password, name: "Ada" });
    const [signedUp] = await activity("auth.signed_up");
    expect(signedUp).toMatchObject({
      msg: "activity",
      service: "api",
      outcome: "ok",
      actor: { email, name: "Ada", demo: false },
      target: { method: "password" },
      ip: session.ip,
      requestId: expect.any(String),
    });
    const { otp } = await takeOtp(harness, email);
    await session.auth("/email-otp/verify-email", { email, otp });
    const [signedIn] = await activity("auth.signed_in");
    expect(signedIn).toMatchObject({
      outcome: "ok",
      actor: { userId: expect.any(String), email, name: "Ada" },
      target: { method: "email-code" },
      ip: session.ip,
      userAgent: expect.any(String),
    });
    // No line, of any kind, carries the password or the code.
    expect(written.join("")).not.toContain(password);
    expect(written.join("")).not.toContain(otp);
  });

  it("say who failed to sign in and why, without what they typed", async () => {
    const session = createSession(harness);
    const email = newEmail();
    const password = newPassword();
    const answer = await session.auth("/sign-in/email", { email, password });
    expect(answer.status).toBe(401);
    const [failed] = await activity("auth.signed_in", { outcome: "failed" });
    expect(failed).toMatchObject({
      level: "warn",
      actor: { email },
      reason: "INVALID_EMAIL_OR_PASSWORD",
      target: { method: "password" },
      ip: session.ip,
    });
    expect(written.join("")).not.toContain(password);
  });

  it("follow a signed-in person through every call, and out", async () => {
    const session = createSession(harness);
    const email = newEmail();
    await session.auth("/sign-up/email", { email, password: newPassword(), name: "Grace" });
    const { otp } = await takeOtp(harness, email);
    await session.auth("/email-otp/verify-email", { email, otp });
    const me = await session.rpc.user.me();
    const [called] = await activity("api.called", {
      target: expect.objectContaining({ procedure: "user.me" }),
    });
    expect(called).toMatchObject({
      outcome: "ok",
      actor: { userId: me.id, email, name: "Grace", demo: false },
      // Every line of the request carries the ids, not only the activity line.
      userId: me.id,
      orgId: me.activeOrganizationId,
      durationMs: expect.any(Number),
    });
    await session.auth("/sign-out");
    const [signedOut] = await activity("auth.signed_out");
    expect(signedOut).toMatchObject({ actor: { userId: me.id, email }, target: { userId: me.id } });
  });

  it("say who signed in with Google, and when they let Director upload to YouTube", async () => {
    const session = createSession(harness);
    const email = newEmail();
    const googleSignIn = { provider: "google", callbackURL: process.env.WEB_URL, loginHint: email };
    const started = await session.auth<{ url: string }>("/sign-in/social", googleSignIn);
    expect((await googleConsent(harness, google.url, session, started)).status).toBe(302);
    const [linked] = await activity("auth.google_linked");
    expect(linked).toMatchObject({
      actor: { userId: expect.any(String), email },
      target: { provider: "google" },
    });
    await activity("auth.signed_in", { target: { method: "google" } });
    const allow = await session.auth<{ url: string }>("/link-social", {
      ...googleSignIn,
      scopes: [YOUTUBE_UPLOAD_SCOPE],
    });
    expect((await googleConsent(harness, google.url, session, allow)).status).toBe(302);
    const [granted] = await activity("auth.youtube_granted");
    expect(granted).toMatchObject({ actor: { email }, target: { provider: "google" } });
    // Once: signing in with Google asked for no upload scope, so only linking granted it.
    expect(activities().filter((entry) => entry.activity === "auth.youtube_granted")).toHaveLength(
      1,
    );
  });

  it("say a call was refused, with its code, when no one is signed in", async () => {
    const session = createSession(harness);
    await expect(session.rpc.user.me()).rejects.toThrow();
    const [refused] = await activity("api.called", { outcome: "refused" });
    expect(refused).toMatchObject({ reason: "UNAUTHENTICATED", target: { procedure: "user.me" } });
  });
});
