import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyTestEnvironment, findEnvExample, testEnvironment } from "./environment";
import { fillPlaceholders, newSecret, PLACEHOLDER, vapidKeyPair } from "./secrets";

const example = (text: string) => {
  const dir = mkdtempSync(join(tmpdir(), "test-env-"));
  writeFileSync(join(dir, ".env.example"), text);
  return dir;
};

describe("the test environment", () => {
  it("is .env.example with its placeholders filled, without NODE_ENV or empty values", () => {
    const dir = example(
      'NODE_ENV=development\nPOSTGRES_PORT=55432\n# a comment\nEMAIL_FROM="App <no-reply@example.com>"\nBETTER_AUTH_SECRET=change-me\nS3_BUCKET=\n',
    );
    const env = testEnvironment(join(dir, ".env.example"));
    expect(env.POSTGRES_PORT).toBe("55432");
    expect(env.EMAIL_FROM).toBe("App <no-reply@example.com>");
    expect(env).not.toHaveProperty("S3_BUCKET");
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.BETTER_AUTH_SECRET).not.toMatch(PLACEHOLDER);
    expect(env.BETTER_AUTH_SECRET?.length).toBeGreaterThanOrEqual(32);
  });

  it("uses the ports of the checkout's own stack of services, when it has one", () => {
    const dir = example("POSTGRES_PORT=55432\nDATABASE_URL=postgresql://localhost:55432/app\n");
    writeFileSync(
      join(dir, ".env.stack"),
      "POSTGRES_PORT=55632\nDATABASE_URL=postgresql://localhost:55632/app\n",
    );
    const env = testEnvironment(join(dir, ".env.example"));
    expect(env.POSTGRES_PORT).toBe("55632");
    expect(env.DATABASE_URL).toBe("postgresql://localhost:55632/app");
  });

  it("never replaces what's already set (CI's services), and says what it set", () => {
    const dir = example("REDIS_URL=redis://localhost:56379\nUNSUBSCRIBE_SECRET=change-me\n");
    const env: NodeJS.ProcessEnv = { REDIS_URL: "redis://localhost:6379" };
    expect(applyTestEnvironment(env, join(dir, ".env.example"))).toEqual(["UNSUBSCRIBE_SECRET"]);
    expect(env.REDIS_URL).toBe("redis://localhost:6379");
    expect(env.UNSUBSCRIBE_SECRET).not.toMatch(PLACEHOLDER);
  });

  it("finds .env.example from any directory below it, and fails clearly without one", () => {
    const dir = example("A=1\n");
    const nested = join(dir, "apps", "api");
    mkdirSync(nested, { recursive: true });
    expect(findEnvExample(nested)).toBe(join(dir, ".env.example"));
    expect(() => findEnvExample(mkdtempSync(join(tmpdir(), "no-env-")))).toThrow(/No .env.example/);
  });

  it("covers every placeholder in the repository's .env.example", () => {
    const env = testEnvironment();
    expect(Object.entries(env).filter(([, value]) => PLACEHOLDER.test(value))).toEqual([]);
  });
});

describe("generated secrets", () => {
  it("have each variable's format", () => {
    expect(newSecret("ENCRYPTION_KEYS")).toMatch(/^\d{4}-\d{2}:[A-Za-z0-9+/]{43}=$/);
    expect(newSecret("BETTER_AUTH_SECRET")).toMatch(/^[\w-]{43}$/);
    expect(newSecret("A")).not.toBe(newSecret("A"));
  });

  it("make a matching VAPID pair, generated together when either is a placeholder", () => {
    const { publicKey, privateKey } = vapidKeyPair();
    expect(Buffer.from(publicKey, "base64url")).toHaveLength(65);
    expect(Buffer.from(privateKey, "base64url")).toHaveLength(32);
    const filled = fillPlaceholders({ VAPID_PUBLIC_KEY: "kept", VAPID_PRIVATE_KEY: "change-me" });
    expect(filled.VAPID_PUBLIC_KEY).not.toBe("kept");
    expect(Buffer.from(filled.VAPID_PRIVATE_KEY ?? "", "base64url")).toHaveLength(32);
    expect(fillPlaceholders({ VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b" })).toEqual({
      VAPID_PUBLIC_KEY: "a",
      VAPID_PRIVATE_KEY: "b",
    });
  });
});
