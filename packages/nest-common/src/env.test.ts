import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import {
  coreEnv,
  databaseEnv,
  directDatabaseEnv,
  port,
  requiredInProduction,
  storageEnv,
  withServicePort,
} from "./env";

afterEach(() => vi.unstubAllEnvs());

describe("environment fragments", () => {
  it("fills a local default outside production, and requires the value in production", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(requiredInProduction(z.string(), "local").parse(undefined)).toBe("local");
    vi.stubEnv("NODE_ENV", "production");
    expect(requiredInProduction(z.string(), "local").safeParse(undefined).success).toBe(false);
    expect(requiredInProduction(z.string(), "local").parse("real")).toBe("real");
  });

  it("reads lists and switches the way the variables are written", () => {
    const core = z.object(coreEnv);
    expect(
      core.parse({ TRUSTED_PROXIES: " loopback, 10.0.0.0/8 ,", LOAD_SHEDDING: "off" }),
    ).toMatchObject({
      TRUSTED_PROXIES: ["loopback", "10.0.0.0/8"],
      LOAD_SHEDDING: false,
    });
    expect(core.parse({})).toMatchObject({ TRUSTED_PROXIES: ["loopback"], LOAD_SHEDDING: true });
  });

  it("names a service's database variables after it, with a pool size by default", () => {
    const database = z.object(databaseEnv("API"));
    expect(database.parse({ API_DATABASE_URL: "postgresql://api@db/app" })).toEqual({
      API_DATABASE_URL: "postgresql://api@db/app",
      API_DATABASE_POOL_MAX: 10,
    });
    expect(
      database.parse({ API_DATABASE_URL: "postgres://api@db/app", API_DATABASE_POOL_MAX: "3" }),
    ).toMatchObject({ API_DATABASE_POOL_MAX: 3 });
  });

  it("takes a port within range, or the service's own default", () => {
    expect(port(3001).parse(undefined)).toBe(3001);
    expect(port(3001).parse("8080")).toBe(8080);
    expect(port(3001).safeParse("70000").success).toBe(false);
  });

  it("listens on PORT when it's set, else on the service's own port from the local .env", () => {
    expect(withServicePort("API", { PORT: "8080", API_PORT: "3101" }).PORT).toBe("8080");
    expect(withServicePort("API", { PORT: "", API_PORT: "3101", OTHER: "x" })).toEqual({
      PORT: "3101",
      API_PORT: "3101",
      OTHER: "x",
    });
    expect(withServicePort("API", {}).PORT).toBeUndefined();
  });

  it("reads the storage switches as booleans", () => {
    const storage = z.object(storageEnv);
    expect(storage.parse({})).toMatchObject({ S3_REGION: "us-east-1", S3_FORCE_PATH_STYLE: false });
    expect(storage.parse({ S3_FORCE_PATH_STYLE: "true" }).S3_FORCE_PATH_STYLE).toBe(true);
  });

  it("names the direct connection after the service, and accepts only Postgres URLs", () => {
    const direct = z.object(directDatabaseEnv("WORKER"));
    expect(direct.parse({ WORKER_DATABASE_DIRECT_URL: "postgres://worker@db:5432/app" })).toEqual({
      WORKER_DATABASE_DIRECT_URL: "postgres://worker@db:5432/app",
    });
    expect(direct.safeParse({ WORKER_DATABASE_DIRECT_URL: "mysql://db/app" }).success).toBe(false);
  });
});
