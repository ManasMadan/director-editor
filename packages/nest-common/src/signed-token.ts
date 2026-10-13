/**
 * Compact HMAC-signed tokens for links that act without a session, like one-click
 * unsubscribe in an email. The token carries its data openly (base64url JSON) and a
 * signature over it and its purpose, so it can't be forged, altered, or reused for
 * another purpose. It doesn't expire by itself; add a timestamp part where that matters.
 *
 *   const tokens = createSignedTokens(env.UNSUBSCRIBE_SECRET);
 *   const token = tokens.sign("unsubscribe", [userId, category]);
 *   tokens.verify("unsubscribe", token);   // [userId, category] or null
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function createSignedTokens(secret: string) {
  if (secret.length < 32) {
    throw new Error("Token secrets must be at least 32 characters");
  }
  const signature = (purpose: string, payload: string) =>
    createHmac("sha256", secret).update(`${purpose}.${payload}`).digest("base64url");

  return {
    sign(purpose: string, parts: string[]) {
      const payload = Buffer.from(JSON.stringify(parts)).toString("base64url");
      return `${payload}.${signature(purpose, payload)}`;
    },
    verify(purpose: string, token: string): string[] | null {
      const [payload, given, extra] = token.split(".");
      if (!payload || !given || extra !== undefined) {
        return null;
      }
      const expected = Buffer.from(signature(purpose, payload));
      const actual = Buffer.from(given);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return null;
      }
      try {
        const parts: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        return Array.isArray(parts) && parts.every((part) => typeof part === "string")
          ? parts
          : null;
      } catch {
        return null;
      }
    },
  };
}
