import { describe, expect, it } from "vitest";
import { authEncryptionKey, parseAuthSecrets } from "./secrets";

const a = "a".repeat(32);
const b = "b".repeat(32);

describe("parseAuthSecrets", () => {
  it("reads versioned secrets, newest first", () => {
    expect(parseAuthSecrets(`2:${b}, 1:${a}`)).toEqual([
      { version: 2, value: b },
      { version: 1, value: a },
    ]);
  });

  it("refuses what would break decryption or weaken it", () => {
    expect(() => parseAuthSecrets(b)).toThrow(/<version>:<secret>/);
    expect(() => parseAuthSecrets(`x:${b}`)).toThrow(/<version>:<secret>/);
    expect(() => parseAuthSecrets("1:short")).toThrow(/at least 32/);
    expect(() => parseAuthSecrets(`1:${a},1:${b}`)).toThrow(/twice/);
    expect(() => parseAuthSecrets(" , ")).toThrow(/no secrets/);
  });
});

describe("authEncryptionKey", () => {
  it("is the single secret until versions exist", () => {
    expect(authEncryptionKey(a, undefined)).toBe(a);
  });

  it("encrypts with the newest version and keeps the single secret for older values", () => {
    const key = authEncryptionKey(a, [
      { version: 2, value: b },
      { version: 1, value: a },
    ]);
    expect(key).toMatchObject({ currentVersion: 2, legacySecret: a });
    expect(typeof key !== "string" && [...key.keys.keys()]).toEqual([2, 1]);
  });
});
