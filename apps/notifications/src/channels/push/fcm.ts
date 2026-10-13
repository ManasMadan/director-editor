/**
 * Firebase Cloud Messaging, HTTP v1 API, authenticated as a service account: a JWT signed
 * with its private key (jose) is exchanged for an OAuth access token (cached until
 * shortly before it expires). No SDK: the protocol is two HTTPS calls.
 */

import { MINUTE_MS, PROVIDER_TIMEOUT_MS } from "@repo/contracts/time";
import { importPKCS8, SignJWT } from "jose";
import * as z from "zod";
import type { PushMessage, PushResult, PushTransport } from "./push-transport";

// What FCM answers, checked: a changed response fails here, by name, not as undefined later.
const tokenResponse = z.object({ access_token: z.string(), expires_in: z.number() });
const sendResponse = z.object({ name: z.string() });
const errorResponse = z
  .object({
    error: z.object({
      status: z.string().optional(),
      details: z
        .array(
          z.object({
            fieldViolations: z.array(z.object({ field: z.string().optional() })).optional(),
          }),
        )
        .optional(),
    }),
  })
  .catch({ error: {} });

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  /** Overridable for tests; Google's endpoints by default. */
  tokenUrl?: string;
  apiUrl?: string;
}

export class FcmTransport implements PushTransport {
  private accessToken: { value: string; expiresAt: number } | undefined;
  private key: Promise<CryptoKey> | undefined;

  constructor(private readonly config: FcmConfig) {}

  private async token() {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + MINUTE_MS) {
      return this.accessToken.value;
    }
    const tokenUrl = this.config.tokenUrl ?? "https://oauth2.googleapis.com/token";
    this.key ??= importPKCS8(this.config.privateKey, "RS256");
    const assertion = await new SignJWT({
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.config.clientEmail)
      .setAudience(tokenUrl)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(await this.key);
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`FCM auth failed: ${response.status} ${await response.text()}`);
    }
    const body = tokenResponse.parse(await response.json());
    this.accessToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  async send(token: string, message: PushMessage): Promise<PushResult> {
    const apiUrl = this.config.apiUrl ?? "https://fcm.googleapis.com";
    const response = await fetch(`${apiUrl}/v1/projects/${this.config.projectId}/messages:send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.token()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: message.title, body: message.body },
          data: message.link ? { link: message.link } : {},
          android: message.collapseKey ? { collapse_key: message.collapseKey } : undefined,
        },
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (response.ok) {
      return { ok: true, providerMessageId: sendResponse.parse(await response.json()).name };
    }
    const text = await response.text();
    return {
      ok: false,
      gone: tokenIsDead(response.status, text),
      error: `FCM ${response.status}: ${text.slice(0, 200)}`,
    };
  }
}

/**
 * Whether FCM's error means the token will never work: UNREGISTERED (404), or
 * INVALID_ARGUMENT naming the token field (a malformed token). INVALID_ARGUMENT about
 * anything else is our message's fault, and forgetting the device for it would be wrong.
 */
export function tokenIsDead(status: number, body: string): boolean {
  if (status === 404 || body.includes("UNREGISTERED")) {
    return true;
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return false;
  }
  const { error } = errorResponse.parse(json);
  return (
    error.status === "INVALID_ARGUMENT" &&
    (error.details ?? []).some((detail) =>
      (detail.fieldViolations ?? []).some((violation) => violation.field === "message.token"),
    )
  );
}
