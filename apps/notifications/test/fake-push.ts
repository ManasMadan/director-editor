/**
 * Local stand-ins for the push providers, strict about what the real ones check: FCM's
 * OAuth token exchange (RS256 JWT) and send API, APNs over h2c (ES256 JWT, topic header)
 * and a Web Push service that decrypts the payload (RFC 8291) and checks the VAPID header.
 *
 * Tokens select the outcome: "dead" tokens are reported unregistered, "malformed" ones
 * refused as an invalid token (FCM's INVALID_ARGUMENT on message.token), "flaky" ones
 * fail with a 500 until `recover()` is called. `whileDelivering`, when set, runs while an
 * FCM send is in flight, before it's answered.
 */
import {
  createECDH,
  createVerify,
  type ECDH,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  createServer as createH2cServer,
  type Http2Server,
  type ServerHttp2Stream,
} from "node:http2";
import type { AddressInfo } from "node:net";
// Typed by ./http_ece.d.ts (the package ships none).
import ece from "http_ece";
import webPush from "web-push";

const { decrypt } = ece;

interface Delivered {
  provider: "fcm" | "apns" | "web";
  token: string;
  title: string;
  body: string;
  link: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

export const DEAD_APNS_TOKEN = "0".repeat(64);
export const FLAKY_APNS_TOKEN = "f".repeat(64);
/** Refused with ExpiredProviderToken for the first provider token used, then delivered. */
export const EXPIRING_APNS_TOKEN = "e".repeat(64);
/** Refused as a token that was never valid (400 BadDeviceToken). */
export const BAD_APNS_TOKEN = "b".repeat(64);
/** Delivered, then the connection is closed with GOAWAY, as Apple does for maintenance. */
export const GOAWAY_APNS_TOKEN = "a0".repeat(32);

function verifyJwt(jwt: string, key: KeyObject, algorithm: "RSA-SHA256" | "SHA256") {
  const [header, claims, signature] = jwt.split(".");
  if (!header || !claims || !signature) {
    return undefined;
  }
  const ok = createVerify(algorithm)
    .update(`${header}.${claims}`)
    .verify(
      algorithm === "SHA256" ? { key, dsaEncoding: "ieee-p1363" } : key,
      Buffer.from(signature, "base64url"),
    );
  return ok
    ? (JSON.parse(Buffer.from(claims, "base64url").toString()) as Record<string, unknown>)
    : undefined;
}

async function readBody(request: AsyncIterable<Buffer | string>) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** APNs's answers for the device tokens it always refuses. */
const APNS_REFUSED: Record<string, { status: number; reason: string }> = {
  [DEAD_APNS_TOKEN]: { status: 410, reason: "Unregistered" },
  [BAD_APNS_TOKEN]: { status: 400, reason: "BadDeviceToken" },
};

/** FCM's answers for tokens it refuses, by the token's prefix. */
const FCM_FAILURES: Record<string, { status: number; body: unknown }> = {
  dead: {
    status: 404,
    body: { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } },
  },
  malformed: {
    status: 400,
    body: {
      error: {
        status: "INVALID_ARGUMENT",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.BadRequest",
            fieldViolations: [
              { field: "message.token", description: "Invalid registration token" },
            ],
          },
        ],
      },
    },
  },
};

export async function startFakePush() {
  const fcmKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const apnsKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const vapid = webPush.generateVAPIDKeys();
  const accessToken = randomBytes(16).toString("hex");
  const delivered: Delivered[] = [];
  const subscribers = new Map<string, { ecdh: ECDH; auth: string; location: boolean }>();
  let healthy = false;
  const hooks: { whileDelivering?: (() => Promise<unknown>) | undefined } = {};

  type Reply = (status: number, body: unknown) => void;

  /** FCM's OAuth token exchange: a signed assertion for the messaging scope. */
  function fcmToken(raw: Buffer, reply: Reply) {
    const assertion = new URLSearchParams(raw.toString()).get("assertion") ?? "";
    const claims = verifyJwt(assertion, fcmKeys.publicKey, "RSA-SHA256");
    if (claims?.scope !== "https://www.googleapis.com/auth/firebase.messaging") {
      return reply(401, { error: "invalid_grant" });
    }
    return reply(200, { access_token: accessToken, expires_in: 3600 });
  }

  /** FCM's send API; the token's prefix picks the outcome. */
  async function fcmSend(request: IncomingMessage, raw: Buffer, reply: Reply) {
    if (request.headers.authorization !== `Bearer ${accessToken}`) {
      return reply(401, { error: { status: "UNAUTHENTICATED" } });
    }
    const { message } = JSON.parse(raw.toString()) as {
      message: {
        token: string;
        notification: { title: string; body: string };
        data: { link?: string };
      };
    };
    // A provider that drops the connection: the transport's fetch throws.
    if (message.token.startsWith("crash")) {
      return request.socket.destroy();
    }
    const failure = Object.entries(FCM_FAILURES).find(([prefix]) =>
      message.token.startsWith(prefix),
    )?.[1];
    if (failure) {
      return reply(failure.status, failure.body);
    }
    if (message.token.startsWith("flaky") && !healthy) {
      return reply(500, { error: { status: "INTERNAL" } });
    }
    await hooks.whileDelivering?.();
    delivered.push({
      provider: "fcm",
      token: message.token,
      ...message.notification,
      link: message.data.link,
      headers: request.headers,
    });
    return reply(200, {
      name: `projects/test-project/messages/${randomBytes(4).toString("hex")}`,
    });
  }

  /** The Web Push service: a message to a subscriber, signed with VAPID and encrypted. */
  function webPushDelivery(
    push: string,
    request: IncomingMessage,
    raw: Buffer,
    response: ServerResponse,
    reply: Reply,
  ) {
    if (push === "gone") {
      return reply(410, {});
    }
    const subscriber = subscribers.get(push);
    const authorization = request.headers.authorization ?? "";
    const signed =
      authorization.startsWith("vapid t=") && authorization.includes(`k=${vapid.publicKey}`);
    if (!subscriber || !signed) {
      return reply(401, {});
    }
    if (request.headers["content-encoding"] !== "aes128gcm" || !request.headers.ttl) {
      return reply(400, {});
    }
    const payload = JSON.parse(
      decrypt(raw, {
        version: "aes128gcm",
        privateKey: subscriber.ecdh,
        authSecret: subscriber.auth,
      }).toString(),
    ) as { title: string; body: string; link?: string };
    delivered.push({
      provider: "web",
      token: push,
      ...payload,
      link: payload.link,
      headers: request.headers,
    });
    // RFC 8030 says to name the message; not every push service does.
    response.writeHead(
      201,
      subscriber.location ? { location: `/messages/${randomBytes(4).toString("hex")}` } : {},
    );
    return response.end();
  }

  // FCM (OAuth + send) and Web Push share one HTTP/1.1 server.
  const http: Server = createServer(async (request: IncomingMessage, response) => {
    const url = new URL(request.url ?? "/", "http://fake");
    const raw = await readBody(request);
    const reply: Reply = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/token") {
      return fcmToken(raw, reply);
    }
    if (url.pathname === "/v1/projects/test-project/messages:send") {
      return fcmSend(request, raw, reply);
    }
    const push = /^\/push\/([\w-]+)$/.exec(url.pathname)?.[1];
    if (push) {
      return webPushDelivery(push, request, raw, response, reply);
    }
    reply(404, {});
  });

  // APNs: HTTP/2 only (h2c here; TLS in production).
  const h2c: Http2Server = createH2cServer();
  const expired = new Set<string>();

  /** Why APNs refuses a send to `token` signed with `jwt`, or undefined when it doesn't. */
  function apnsRefusal(
    token: string,
    jwt: string,
    headers: Record<string, string | string[] | undefined>,
  ) {
    const claims = verifyJwt(jwt, apnsKeys.publicKey, "SHA256");
    if (claims?.iss !== "TEAMID1234") {
      return { status: 403, reason: "InvalidProviderToken" };
    }
    if (headers["apns-topic"] !== "dev.boilerplate.app") {
      return { status: 400, reason: "TopicDisallowed" };
    }
    const always = APNS_REFUSED[token];
    if (always) {
      return always;
    }
    // The first provider token that sends to it expires; a newly signed one works.
    if (token === EXPIRING_APNS_TOKEN && (expired.size === 0 || expired.has(jwt))) {
      expired.add(jwt);
      return { status: 403, reason: "ExpiredProviderToken" };
    }
    if (token === FLAKY_APNS_TOKEN && !healthy) {
      return { status: 500, reason: "InternalServerError" };
    }
    return undefined;
  }
  h2c.on("stream", async (stream: ServerHttp2Stream, headers) => {
    const raw = await readBody(stream);
    const reply = (status: number, body?: unknown) => {
      stream.respond({ ":status": status, "content-type": "application/json" });
      stream.end(body ? JSON.stringify(body) : undefined);
    };
    const token = /^\/3\/device\/([0-9a-f]+)$/.exec(String(headers[":path"]))?.[1];
    const jwt = String(headers.authorization ?? "").replace(/^bearer /, "");
    if (!token) {
      return reply(403, { reason: "InvalidProviderToken" });
    }
    const refused = apnsRefusal(token, jwt, headers);
    if (refused) {
      return reply(refused.status, { reason: refused.reason });
    }
    const { aps, link } = JSON.parse(raw.toString()) as {
      aps: { alert: { title: string; body: string } };
      link?: string;
    };
    delivered.push({ provider: "apns", token, ...aps.alert, link, headers });
    reply(200);
    if (token === GOAWAY_APNS_TOKEN) {
      stream.session?.goaway();
    }
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => h2c.listen(0, "127.0.0.1", resolve));
  const httpUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const h2cUrl = `http://127.0.0.1:${(h2c.address() as AddressInfo).port}`;
  const pem = (key: KeyObject) => key.export({ type: "pkcs8", format: "pem" }).toString();

  return {
    delivered,
    hooks,
    env: {
      FCM_PROJECT_ID: "test-project",
      FCM_CLIENT_EMAIL: "push@test-project.iam.gserviceaccount.com",
      FCM_PRIVATE_KEY: pem(fcmKeys.privateKey),
      FCM_TOKEN_URL: `${httpUrl}/token`,
      FCM_API_URL: httpUrl,
      APNS_KEY_ID: "KEYID12345",
      APNS_TEAM_ID: "TEAMID1234",
      APNS_PRIVATE_KEY: pem(apnsKeys.privateKey),
      APNS_BUNDLE_ID: "dev.boilerplate.app",
      APNS_URL: h2cUrl,
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: "mailto:push@boilerplate.dev",
      WEB_PUSH_TEST_ORIGIN: httpUrl,
    },
    /**
     * A browser subscription on the fake push service, as stored in the device table.
     * `location: false`: its push service accepts messages without naming them.
     */
    webSubscription(endpoint?: string, { location = true } = {}) {
      const id = randomBytes(8).toString("hex");
      const ecdh = createECDH("prime256v1");
      ecdh.generateKeys();
      const auth = randomBytes(16).toString("base64url");
      subscribers.set(id, { ecdh, auth, location });
      return {
        id,
        token: JSON.stringify({
          endpoint: endpoint ?? `${httpUrl}/push/${id}`,
          keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth },
        }),
      };
    },
    goneSubscription() {
      return this.webSubscription(`${httpUrl}/push/gone`).token;
    },
    /** Flaky tokens start succeeding. */
    recover() {
      healthy = true;
    },
    async close() {
      await new Promise((resolve) => http.close(resolve));
      await new Promise((resolve) => h2c.close(resolve));
    },
  };
}
export type FakePush = Awaited<ReturnType<typeof startFakePush>>;
