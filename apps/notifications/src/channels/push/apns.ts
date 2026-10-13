/**
 * Apple Push Notification service over HTTP/2 with token-based auth: a short-lived ES256
 * JWT (key id + team id, signed with jose), refreshed every 50 minutes as Apple requires,
 * and at once when Apple says it expired. One HTTP/2 request per notification on a
 * kept-open connection, opened again after an error or Apple's GOAWAY.
 */
import { type ClientHttp2Session, connect } from "node:http2";
import { MINUTE_MS, PROVIDER_TIMEOUT_MS } from "@repo/contracts/time";
import { importPKCS8, SignJWT } from "jose";
import * as z from "zod";
import type { PushMessage, PushResult, PushTransport } from "./push-transport";

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** The .p8 key's contents. */
  privateKey: string;
  bundleId: string;
  /** api.push.apple.com, or the sandbox for development builds; overridable for tests. */
  url: string;
  /** How long one notification may take (default 10 s). */
  timeoutMs?: number;
}

const REFRESH_MS = 50 * MINUTE_MS;
/** The reasons that mean the token will never work again (Apple's error list). */
const DEAD_TOKEN = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);
const apnsError = z.object({ reason: z.string() });

/** Apple's reason for an error; none for a success (empty body) or a body that isn't JSON. */
function reasonOf(text: string) {
  try {
    return apnsError.parse(JSON.parse(text)).reason;
  } catch {
    return "";
  }
}

type Answer = { status: number; reason: string; text: string } | { failed: string };

export class ApnsTransport implements PushTransport {
  private jwt: { value: string; issuedAt: number } | undefined;
  private key: Promise<CryptoKey> | undefined;
  private session: ClientHttp2Session | undefined;

  constructor(private readonly config: ApnsConfig) {}

  private async token(renew: boolean) {
    if (!renew && this.jwt && Date.now() - this.jwt.issuedAt < REFRESH_MS) {
      return this.jwt.value;
    }
    this.key ??= importPKCS8(this.config.privateKey, "ES256");
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.config.keyId })
      .setIssuer(this.config.teamId)
      .setIssuedAt()
      .sign(await this.key);
    this.jwt = { value, issuedAt: Date.now() };
    return value;
  }

  private connection() {
    if (!this.session || this.session.closed || this.session.destroyed) {
      const session = connect(this.config.url);
      session.on("error", () => session.destroy());
      // Apple is closing the connection (maintenance, too many streams): the next
      // notification opens a new one.
      session.on("goaway", () => session.close());
      this.session = session;
    }
    return this.session;
  }

  private request(token: string, body: string, jwt: string, collapseKey?: string) {
    return new Promise<Answer>((resolve) => {
      const request = this.connection().request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": this.config.bundleId,
        "apns-push-type": "alert",
        ...(collapseKey && { "apns-collapse-id": collapseKey.slice(0, 64) }),
        "content-type": "application/json",
      });
      let status = 0;
      let text = "";
      request.setTimeout(this.config.timeoutMs ?? PROVIDER_TIMEOUT_MS, () => {
        request.close();
        resolve({ failed: "APNs timed out" });
      });
      request.on("response", (headers) => {
        status = Number(headers[":status"]);
      });
      request.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      request.on("end", () => {
        resolve({ status, reason: reasonOf(text), text });
      });
      request.on("error", (error) => resolve({ failed: error.message }));
      request.end(body);
    });
  }

  async send(token: string, message: PushMessage): Promise<PushResult> {
    const body = JSON.stringify({
      aps: { alert: { title: message.title, body: message.body }, sound: "default" },
      ...(message.link && { link: message.link }),
    });
    let answer = await this.request(token, body, await this.token(false), message.collapseKey);
    // Apple dropped our token early (clock skew, a revoked key rotated back): sign a new
    // one and try once more.
    if ("reason" in answer && answer.reason === "ExpiredProviderToken") {
      answer = await this.request(token, body, await this.token(true), message.collapseKey);
    }
    if ("failed" in answer) {
      return { ok: false, gone: false, error: answer.failed };
    }
    if (answer.status === 200) {
      return { ok: true };
    }
    return {
      ok: false,
      gone: answer.status === 410 || DEAD_TOKEN.has(answer.reason),
      error: `APNs ${answer.status}: ${answer.text.slice(0, 200)}`,
    };
  }

  close() {
    this.session?.close();
  }
}
