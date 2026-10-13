/**
 * The secrets a local environment is generated with: by `bun run setup` for `.env`, and
 * for every test run (./environment.ts). `.env.example` carries placeholders for them.
 */
import { createECDH, randomBytes } from "node:crypto";

/** A value in `.env.example` that must be replaced before anything uses it. */
export const PLACEHOLDER = /^(change-me.*|replace-me.*)$/;

/** A fresh random secret in the format the variable expects. */
export function newSecret(key: string): string {
  // SecretBox keys carry an id so they can be rotated: "<id>:<32-byte base64 key>".
  if (key === "ENCRYPTION_KEYS") {
    return `${new Date().toISOString().slice(0, 7)}:${randomBytes(32).toString("base64")}`;
  }
  return randomBytes(32).toString("base64url");
}

/** A browser-push (VAPID) key pair: P-256, base64url, the private key exactly 32 bytes. */
export function vapidKeyPair(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  // The raw scalar can come back shorter than 32 bytes; VAPID wants exactly 32.
  const privateKey = Buffer.from(ecdh.getPrivateKey("hex").padStart(64, "0"), "hex");
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: privateKey.toString("base64url"),
  };
}

/**
 * `values` with every placeholder replaced by a generated secret; the VAPID pair is
 * generated together, since its halves must match.
 */
export function fillPlaceholders(values: Record<string, string>): Record<string, string> {
  const filled = { ...values };
  if (
    ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"].some((key) => PLACEHOLDER.test(filled[key] ?? ""))
  ) {
    const pair = vapidKeyPair();
    filled.VAPID_PUBLIC_KEY = pair.publicKey;
    filled.VAPID_PRIVATE_KEY = pair.privateKey;
  }
  for (const [key, value] of Object.entries(filled)) {
    if (PLACEHOLDER.test(value)) {
      filled[key] = newSecret(key);
    }
  }
  return filled;
}
