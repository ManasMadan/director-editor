import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { keysFromEnv, SecretBox, webhookSecretContext } from "./crypto";

const key = () => randomBytes(32).toString("base64");
const row = webhookSecretContext("0198d0c2-0000-7000-8000-000000000001");

/** A value as SecretBox wrote it before it bound values to their row. */
function legacy(keyId: string, base64Key: string, plaintext: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(base64Key, "base64"), iv);
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return ["v1", keyId, iv.toString("base64url"), body.toString("base64url")].join(".");
}

describe("SecretBox", () => {
  it("round-trips and tags ciphertexts with the active key id", () => {
    const box = new SecretBox(keysFromEnv(`k2:${key()}`));
    const stored = box.encrypt("whsec_123", row);
    expect(stored.startsWith("v2.k2.")).toBe(true);
    expect(box.decrypt(stored, row)).toBe("whsec_123");
  });

  it("won't decrypt a value copied into another row", () => {
    const box = new SecretBox(keysFromEnv(`k1:${key()}`));
    const stored = box.encrypt("whsec_123", row);
    expect(() =>
      box.decrypt(stored, webhookSecretContext("0198d0c2-0000-7000-8000-000000000002")),
    ).toThrow();
  });

  it("decrypts values written with a previous key after rotation", () => {
    const oldKey = key();
    const before = new SecretBox(keysFromEnv(`k1:${oldKey}`)).encrypt("secret", row);
    const after = new SecretBox(keysFromEnv(`k2:${key()},k1:${oldKey}`));
    expect(after.decrypt(before, row)).toBe("secret");
    expect(after.needsRotation(before)).toBe(true);
    expect(after.needsRotation(after.encrypt("secret", row))).toBe(false);
  });

  it("still reads values written before they were bound to a row, and flags them", () => {
    const k1 = key();
    const box = new SecretBox(keysFromEnv(`k1:${k1}`));
    const stored = legacy("k1", k1, "whsec_old");
    expect(box.decrypt(stored, row)).toBe("whsec_old");
    expect(box.needsRotation(stored)).toBe(true);
  });

  it("rejects tampered ciphertexts and unknown keys", () => {
    const box = new SecretBox(keysFromEnv(`k1:${key()}`));
    const stored = box.encrypt("secret", row);
    // Flip one bit of the encrypted body (editing base64 text can land on padding bits
    // that decode to the same bytes, which would make this test pass by luck).
    const [version, id, iv, body] = stored.split(".");
    const bytes = Buffer.from(body ?? "", "base64url");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    const tampered = [version, id, iv, bytes.toString("base64url")].join(".");
    expect(() => box.decrypt(tampered, row)).toThrow();
    expect(() => new SecretBox(keysFromEnv(`k9:${key()}`)).decrypt(stored, row)).toThrow(
      /Unknown encryption key/,
    );
  });

  it("refuses keys of the wrong length", () => {
    expect(() => keysFromEnv(`k1:${randomBytes(16).toString("base64")}`)).toThrow(/32 bytes/);
  });

  it("refuses entries that aren't `id:base64key`, and an empty list", () => {
    for (const value of ["", key(), `:${key()}`, "k1:", `bad id:${key()}`, `k1:${key()},`]) {
      expect(() => keysFromEnv(value)).toThrow(/id:base64key/);
    }
  });

  it("refuses ciphertexts in a format it doesn't write", () => {
    const box = new SecretBox(keysFromEnv(`k1:${key()}`));
    const [, id, iv, body] = box.encrypt("secret", row).split(".");
    for (const stored of [
      "plaintext",
      `v3.${id}.${iv}.${body}`,
      `v2.${id}.${iv}`,
      `v2..${iv}.${body}`,
    ]) {
      expect(() => box.decrypt(stored, row)).toThrow(/Unrecognised ciphertext format/);
    }
  });
});
