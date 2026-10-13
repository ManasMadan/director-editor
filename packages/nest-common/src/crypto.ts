/**
 * Encryption for secrets stored in our database (webhook signing secrets, third-party
 * tokens). AES-256-GCM with a key id on every ciphertext, so keys rotate without a
 * big-bang re-encryption:
 *
 *   ENCRYPTION_KEYS="2026-09:base64key,2026-01:base64oldkey"   (first = active)
 *   const box = new SecretBox(keysFromEnv(env.ENCRYPTION_KEYS));
 *   const stored = box.encrypt("whsec_...", `webhook_endpoint:${id}`);  // "v2.2026-09.<iv>.<ciphertext>"
 *   box.decrypt(stored, `webhook_endpoint:${id}`);  // any listed key id still decrypts
 *
 * The second argument names the row the value belongs to and is bound to the
 * ciphertext (GCM's additional data): a value copied into another row fails to decrypt,
 * so someone who can write the table can't make one endpoint sign with another's
 * secret. Values written before that (`v1`) still decrypt, without the check, and
 * `needsRotation` reports them.
 *
 * Rotation: prepend a new key, deploy, re-encrypt in the background (decrypt + encrypt
 * with the active key: `bun run --filter @repo/api secrets:reencrypt`), then drop the
 * old key.
 *
 * This is one of two schemes for secrets at rest. better-auth encrypts its own columns
 * (OAuth tokens, 2FA secrets, JWT signing keys) with `symmetricEncrypt` under
 * BETTER_AUTH_SECRETS; it has to, since better-auth reads and writes them itself.
 * Everything the app stores itself uses this one, which a KMS can take over (below).
 * The re-encryption job moves both onto their newest keys.
 *
 * Seam: keys come from a `KeyProvider`. Today it reads them from the environment (in a
 * cluster, the service's Secret, decrypted from SOPS by Argo CD). To use a KMS, implement
 * `KeyProvider` to unwrap data keys with the KMS; ciphertext format and callers stay the same.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { required } from "@repo/contracts/objects";

export interface KeyProvider {
  /** The key new ciphertexts are written with. */
  active(): { id: string; key: Buffer };
  /** Any key that may still appear in stored ciphertexts. */
  get(id: string): Buffer | undefined;
}

/** Parses `id:base64key,id:base64key` (first is active). Keys must be 32 bytes. */
export function keysFromEnv(value: string): KeyProvider {
  const keys = value.split(",").map((entry) => {
    const [id, encoded] = entry.trim().split(":");
    if (!id || !encoded || !/^[\w-]+$/.test(id)) {
      throw new Error("ENCRYPTION_KEYS entries must look like `id:base64key`");
    }
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      throw new Error(`Encryption key "${id}" must be 32 bytes (openssl rand -base64 32)`);
    }
    return { id, key };
  });
  // split() always yields an entry, and each one was checked above.
  const first = required(keys[0], "an encryption key");
  const byId = new Map(keys.map(({ id, key }) => [id, key]));
  return { active: () => first, get: (id) => byId.get(id) };
}

/** v1: no additional data (read only). v2: bound to the context passed to `encrypt`. */
const VERSION = "v2";

export class SecretBox {
  constructor(private readonly keys: KeyProvider) {}

  /** `context` names the row the value is stored in, like `webhook_endpoint:<id>`. */
  encrypt(plaintext: string, context: string): string {
    const { id, key } = this.keys.active();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const body = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return [VERSION, id, iv.toString("base64url"), body.toString("base64url")].join(".");
  }

  /** Fails if `stored` was encrypted for another context, or tampered with. */
  decrypt(stored: string, context: string): string {
    const [version, id, iv, body] = stored.split(".");
    if ((version !== VERSION && version !== "v1") || !id || !iv || !body) {
      throw new Error("Unrecognised ciphertext format");
    }
    const key = this.keys.get(id);
    if (!key) {
      throw new Error(
        `Unknown encryption key "${id}"; it may have been removed before re-encryption finished`,
      );
    }
    const data = Buffer.from(body, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    if (version === VERSION) {
      decipher.setAAD(Buffer.from(context, "utf8"));
    }
    decipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([
      decipher.update(data.subarray(0, data.length - 16)),
      decipher.final(),
    ]).toString("utf8");
  }

  /** Whether a stored value was written with an older key or format and should be re-encrypted. */
  needsRotation(stored: string): boolean {
    const [version, id] = stored.split(".");
    return version !== VERSION || id !== this.keys.active().id;
  }
}

/** The context a webhook endpoint's signing secrets are encrypted for. */
export const webhookSecretContext = (endpointId: string) => `webhook_endpoint:${endpointId}`;

/**
 * A new webhook signing secret in the Standard Webhooks format (standardwebhooks.com):
 * `whsec_` and the base64 of 24 random bytes, which its libraries read as the key.
 */
export const newWebhookSecret = () => `whsec_${randomBytes(24).toString("base64")}`;
