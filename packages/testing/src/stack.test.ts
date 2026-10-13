import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { defaultPorts, STACKS, stackValues } from "./stack";

const example = parseEnv(
  readFileSync(join(import.meta.dirname, "../../../.env.example"), "utf8"),
) as Record<string, string>;

describe("a stack of local services", () => {
  it("moves every port and the local URLs that name it, and names its compose project", () => {
    const current = {
      POSTGRES_PORT: "55432",
      API_DATABASE_URL: "postgresql://app_api:app_api@localhost:55432/app",
      REDIS_URL: "redis://127.0.0.1:56379",
      STRIPE_API_URL: "http://127.0.0.1:12111",
      WEB_URL: "http://localhost:3000",
    };
    const ports = { POSTGRES_PORT: "55432", VALKEY_PORT: "56379", NOT_A_PORT: "x" };
    expect(stackValues(current, ports, 2, "boilerplate")).toEqual({
      POSTGRES_PORT: "55632",
      VALKEY_PORT: "56579",
      API_DATABASE_URL: "postgresql://app_api:app_api@localhost:55632/app",
      REDIS_URL: "redis://127.0.0.1:56579",
      COMPOSE_PROJECT_NAME: "boilerplate-stack2",
    });
  });

  it("moves from one stack to another, and back to the defaults", () => {
    const ports = { POSTGRES_PORT: "55432" };
    const onTwo = { POSTGRES_PORT: "55632", DATABASE_URL: "postgresql://localhost:55632/app" };
    expect(stackValues(onTwo, ports, 0, "boilerplate")).toEqual({
      POSTGRES_PORT: "55432",
      DATABASE_URL: "postgresql://localhost:55432/app",
      COMPOSE_PROJECT_NAME: "boilerplate",
    });
    const already = { ...onTwo, COMPOSE_PROJECT_NAME: "boilerplate-stack2" };
    expect(stackValues(already, ports, 2, "boilerplate")).toEqual({});
    // Without a project (the tests' environment), no name.
    expect(stackValues({}, ports, 1)).toEqual({ POSTGRES_PORT: "55532" });
  });

  it("moves the apps' own ports with the services', and every local URL that names one", () => {
    expect(stackValues(example, example, 1)).toMatchObject({
      WEB_PORT: "3100",
      API_PORT: "3101",
      WORKER_PORT: "3102",
      NOTIFICATIONS_PORT: "3103",
      WEBHOOKS_PORT: "3104",
      MOBILE_WEB_PORT: "3105",
      AI_PORT: "8100",
      EMAIL_PREVIEW_PORT: "3130",
      EXPO_PORT: "8181",
      STORYBOOK_PORT: "6106",
      STRIPE_FAKE_PORT: "12211",
      // The site, its auth origin and the mobile app's API, the web server's upstreams,
      // and the mobile web build's sign-in origin.
      WEB_URL: "http://localhost:3100",
      BETTER_AUTH_URL: "http://localhost:3100",
      EXPO_PUBLIC_API_URL: "http://localhost:3100",
      API_URL: "http://localhost:3101",
      AI_URL: "http://localhost:8100",
      APP_ORIGINS: "http://localhost:3105",
    });
    // The fake Stripe's URL, set by hand in .env, follows it too.
    expect(stackValues({ STRIPE_API_URL: "http://127.0.0.1:12111" }, example, 1)).toMatchObject({
      STRIPE_API_URL: "http://127.0.0.1:12211",
    });
  });

  it("refuses a stack that isn't 0 to 9", () => {
    for (const stack of [-1, 10, 1.5, Number.NaN]) {
      expect(() => stackValues({}, {}, stack)).toThrow("from 0 to 9");
    }
  });

  it("keeps every port of every stack distinct, for every port .env.example names", () => {
    const ports = Object.keys(defaultPorts(example));
    expect(ports).toContain("POSTGRES_PORT");
    const all = Array.from({ length: STACKS }, (_, stack) =>
      ports.map((key) => stackValues(example, example, stack)[key] ?? example[key]),
    ).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(Math.max(...all.map(Number))).toBeLessThan(65536);
  });
});
