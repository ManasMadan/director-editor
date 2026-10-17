import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyTestEnvironment, findEnvExample, testEnvironment } from "./environment";
import { fillPlaceholders, newSecret, PLACEHOLDER } from "./secrets";

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
    const dir = example("REDIS_URL=redis://localhost:56379\nAI_SERVICE_SECRET=change-me\n");
    const env: NodeJS.ProcessEnv = { REDIS_URL: "redis://localhost:6379" };
    expect(applyTestEnvironment(env, join(dir, ".env.example"))).toEqual(["AI_SERVICE_SECRET"]);
    expect(env.REDIS_URL).toBe("redis://localhost:6379");
    expect(env.AI_SERVICE_SECRET).not.toMatch(PLACEHOLDER);
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
  it("are 32 random bytes, different every time", () => {
    expect(newSecret()).toMatch(/^[\w-]{43}$/);
    expect(newSecret()).not.toBe(newSecret());
  });

  it("replace placeholders only", () => {
    expect(fillPlaceholders({ KEPT: "a", NEW: "change-me" })).toEqual({
      KEPT: "a",
      NEW: expect.stringMatching(/^[\w-]{43}$/),
    });
  });
});
