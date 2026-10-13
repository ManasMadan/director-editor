/**
 * The push and SMS transports on their own, against the local provider fakes and a few
 * servers that misbehave: what each answer or failure becomes. The dispatcher's use of
 * them is notifications.integration.test.ts.
 */
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createServer as createH2cServer, type Http2Server } from "node:http2";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ApnsTransport } from "../src/channels/push/apns";
import { FcmTransport } from "../src/channels/push/fcm";
import { WebPushTransport } from "../src/channels/push/web-push";
import { TwilioTransport } from "../src/channels/sms/twilio";
import {
  BAD_APNS_TOKEN,
  EXPIRING_APNS_TOKEN,
  type FakePush,
  GOAWAY_APNS_TOKEN,
  startFakePush,
} from "./fake-push";
import { type FakeTwilio, startFakeTwilio } from "./fake-twilio";

let push: FakePush;
let twilio: FakeTwilio;
/** A port nothing listens on. */
let closedPort: number;
/** An HTTP/2 server that takes requests and never answers them. */
let silent: Http2Server;
/** An HTTP server that answers every request with a 502 page, as a broken proxy would. */
let badGateway: Server;

const listen = async (server: Server | Http2Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

beforeAll(async () => {
  push = await startFakePush();
  twilio = await startFakeTwilio();
  const probe = createServer();
  closedPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  silent = createH2cServer();
  silent.on("stream", () => undefined);
  badGateway = createServer((_request, response) => {
    response.writeHead(502, { "content-type": "text/html" }).end("<html>Bad Gateway</html>");
  });
  await listen(silent);
  await listen(badGateway);
});
afterAll(async () => {
  await push?.close();
  await twilio?.close();
  await new Promise((resolve) => silent?.close(resolve));
  await new Promise((resolve) => badGateway?.close(resolve));
});

const message = { title: "Hello", body: "World" };
const fcm = (overrides: Partial<ConstructorParameters<typeof FcmTransport>[0]> = {}) =>
  new FcmTransport({
    projectId: push.env.FCM_PROJECT_ID,
    clientEmail: push.env.FCM_CLIENT_EMAIL,
    privateKey: push.env.FCM_PRIVATE_KEY,
    tokenUrl: push.env.FCM_TOKEN_URL,
    apiUrl: push.env.FCM_API_URL,
    ...overrides,
  });
const apns = (overrides: Partial<ConstructorParameters<typeof ApnsTransport>[0]> = {}) =>
  new ApnsTransport({
    keyId: push.env.APNS_KEY_ID,
    teamId: push.env.APNS_TEAM_ID,
    privateKey: push.env.APNS_PRIVATE_KEY,
    bundleId: push.env.APNS_BUNDLE_ID,
    url: push.env.APNS_URL,
    ...overrides,
  });
const webPush = (testOrigin = push.env.WEB_PUSH_TEST_ORIGIN) =>
  new WebPushTransport({
    publicKey: push.env.VAPID_PUBLIC_KEY,
    privateKey: push.env.VAPID_PRIVATE_KEY,
    subject: push.env.VAPID_SUBJECT,
    testOrigin,
  });

describe("FCM", () => {
  it("sends a message without a link or a collapse key", async () => {
    const token = `plain-${Date.now()}`;
    expect(await fcm().send(token, message)).toMatchObject({ ok: true });
    expect(push.delivered.find((sent) => sent.token === token)).toMatchObject({
      ...message,
      link: undefined,
    });
  });

  it("fails when Google won't trade the service account's key for a token", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const stranger = fcm({
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    });
    await expect(stranger.send("any", message)).rejects.toThrow(/FCM auth failed: 401/);
  });
});

describe("APNs", () => {
  it("signs a new provider token and tries again when Apple says it expired", async () => {
    const client = apns();
    expect(await client.send(EXPIRING_APNS_TOKEN, message)).toEqual({ ok: true });
    const tries = push.delivered.filter((sent) => sent.token === EXPIRING_APNS_TOKEN);
    expect(tries).toHaveLength(1);
    client.close();
  });

  it("forgets a device token Apple says was never valid", async () => {
    const client = apns();
    expect(await client.send(BAD_APNS_TOKEN, message)).toMatchObject({
      ok: false,
      gone: true,
      error: expect.stringContaining("BadDeviceToken"),
    });
    client.close();
  });

  it("opens a new connection after Apple closes one with GOAWAY", async () => {
    const client = apns();
    expect(await client.send(GOAWAY_APNS_TOKEN, message)).toEqual({ ok: true });
    await vi.waitFor(async () =>
      expect(await client.send("c".repeat(64), message)).toEqual({ ok: true }),
    );
    client.close();
  });

  it("gives up on a notification APNs doesn't answer", async () => {
    const stuck = apns({
      url: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`,
      timeoutMs: 200,
    });
    expect(await stuck.send("a".repeat(64), message)).toEqual({
      ok: false,
      gone: false,
      error: "APNs timed out",
    });
    stuck.close();
  });

  it("reports a connection that fails, and connects again for the next one", async () => {
    const down = apns({ url: `http://127.0.0.1:${closedPort}` });
    const first = await down.send("a".repeat(64), message);
    expect(first).toMatchObject({
      ok: false,
      gone: false,
      error: expect.stringMatching(/ECONNREFUSED/),
    });
    expect(await down.send("a".repeat(64), message)).toMatchObject({ ok: false, gone: false });
    down.close();
  });
});

describe("Web Push", () => {
  it("forgets a stored subscription that isn't JSON", async () => {
    expect(await webPush().send("not json", message)).toEqual({
      ok: false,
      gone: true,
      error: "stored subscription isn't JSON",
    });
  });

  it("forgets a stored subscription without the keys a browser gives", async () => {
    const token = JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/x" });
    expect(await webPush().send(token, message)).toEqual({
      ok: false,
      gone: true,
      error: "stored subscription is malformed",
    });
  });

  it("reports a push service it can't reach, keeping the subscription", async () => {
    const origin = `http://127.0.0.1:${closedPort}`;
    const { token } = push.webSubscription(`${origin}/push/x`);
    expect(await webPush(origin).send(token, message)).toMatchObject({
      ok: false,
      gone: false,
      error: expect.stringMatching(/^Web Push: /),
    });
  });

  it("accepts a push service that doesn't name the message", async () => {
    const { token } = push.webSubscription(undefined, { location: false });
    expect(await webPush().send(token, message)).toEqual({
      ok: true,
      providerMessageId: undefined,
    });
  });
});

describe("Twilio", () => {
  const transport = (overrides: Partial<ConstructorParameters<typeof TwilioTransport>[0]> = {}) =>
    new TwilioTransport({
      accountSid: twilio.env.TWILIO_ACCOUNT_SID,
      authToken: twilio.env.TWILIO_AUTH_TOKEN,
      from: twilio.env.TWILIO_FROM,
      apiUrl: twilio.env.TWILIO_API_URL,
      ...overrides,
    });

  it("lets a Messaging Service pick the sender", async () => {
    const phone = "+14155550199";
    expect(await transport({ from: twilio.messagingService }).send(phone, "hi")).toMatchObject({
      ok: true,
    });
    expect(twilio.to(phone)).toEqual([{ to: phone, from: twilio.messagingService, body: "hi" }]);
  });

  it("reports Twilio being unreachable as worth retrying", async () => {
    expect(
      await transport({ apiUrl: `http://127.0.0.1:${closedPort}` }).send("+14155550199", "hi"),
    ).toMatchObject({
      ok: false,
      permanent: false,
      suppress: null,
      error: expect.stringMatching(/^Twilio: /),
    });
  });

  it("reports an answer that isn't Twilio's JSON by its status", async () => {
    const port = (badGateway.address() as AddressInfo).port;
    expect(
      await transport({ apiUrl: `http://127.0.0.1:${port}` }).send("+14155550199", "hi"),
    ).toEqual({
      ok: false,
      permanent: false,
      suppress: null,
      error: "Twilio 502 0: unknown error",
    });
  });
});
