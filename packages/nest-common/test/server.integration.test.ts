/**
 * A service the way createServer and bootstrap build it, in process: health checks
 * against the docker compose Postgres and Valkey, request ids, CORS, load shedding, and
 * errors in the contract's shape.
 */
import { type AddressInfo, connect } from "node:net";
import { Controller, Get, type INestApplication, Module, type Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eventually } from "@repo/testing/eventually";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
// Through the package's entry point, as the services import it.
import {
  bootstrap,
  createServer,
  DatabaseModule,
  HealthModule,
  LoggerModule,
  RedisModule,
} from "../src";
import { redisDatabase } from "../src/testing";

@Controller("demo")
class DemoController {
  @Get("ok")
  ok() {
    return { ok: true };
  }

  @Get("broken")
  broken() {
    throw new Error("a bug");
  }
}

const logger = LoggerModule.forRoot({ service: "test", level: "silent" });
const database = (url: string) => DatabaseModule.forRoot({ url, poolMax: 1, service: "test" });

@Module({
  imports: [
    logger,
    database(process.env.MIGRATOR_DATABASE_URL as string),
    RedisModule.forRoot({ url: redisDatabase(12) }),
    HealthModule.forRoot(["db", "redis"]),
  ],
  controllers: [DemoController],
})
class HealthyModule {}

@Module({
  imports: [
    logger,
    database("postgresql://nobody:nobody@127.0.0.1:1/none"),
    HealthModule.forRoot(["db"]),
  ],
})
class DatabaseDownModule {}

/** Checks registered for dependencies the service never set up. */
@Module({ imports: [logger, HealthModule.forRoot(["db", "redis"])] })
class UnregisteredModule {}

const options = { service: "test", logLevel: "silent" as const, trustedProxies: ["loopback"] };
const apps: INestApplication[] = [];
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  for (const app of apps) {
    await app.close();
  }
});

async function build(module: Type, extra: { loadShedding?: boolean } = {}) {
  const app = await createServer(module, { ...options, ...extra });
  apps.push(app);
  await app.init();
  return app;
}

const get = (app: NestFastifyApplication, url: string) =>
  app.getHttpAdapter().getInstance().inject({ method: "GET", url });

describe("bootstrap", () => {
  it("listens, answers health checks, and echoes a request id", async () => {
    // Load shedding off: it measures event loop use since it was registered, and on a busy
    // runner booting the app alone can push that past its limit, so a request here could
    // be shed. Shedding is tested on its own below.
    const app = await bootstrap(HealthyModule, {
      ...options,
      port: 0,
      corsOrigins: ["https://app.example"],
      loadShedding: false,
    });
    apps.push(app);
    const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    const live = await fetch(`${base}/health/live`, { headers: { "x-request-id": "probe-1" } });
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "ok" });
    // From a trusted peer (loopback), the caller's id is kept.
    expect(live.headers.get("x-request-id")).toBe("probe-1");

    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ok" });
    const dependencies = await fetch(`${base}/health/dependencies`);
    expect(dependencies.status).toBe(200);
    expect(await dependencies.json()).toMatchObject({
      status: "ok",
      info: { db: { status: "up" }, redis: { status: "up" } },
    });

    const cors = await fetch(`${base}/demo/ok`, { headers: { origin: "https://app.example" } });
    expect(await cors.json()).toEqual({ ok: true });
    expect(cors.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(cors.headers.get("access-control-expose-headers")).toBe("x-request-id");
  });
});

describe("shutting down", () => {
  it("hangs up a connection that never sent a request, instead of waiting for it", async () => {
    // A browser's preconnect, or an HTTP client reconnecting for a request it then dropped.
    const app = await bootstrap(UnregisteredModule, { ...options, port: 0 });
    const { port } = app.getHttpServer().address() as AddressInfo;
    // Hung up on, it may see a reset: expected.
    const unused = connect(port, "127.0.0.1")
      .resume()
      .on("error", () => undefined);
    await new Promise((resolve) => unused.once("connect", resolve));
    // Connected on the client's side isn't yet accepted on the server's: wait until it is,
    // or the close finds nothing to hang up and the test passes without testing it.
    const server = app.getHttpServer();
    await eventually(
      () =>
        new Promise<number>((resolve, reject) =>
          server.getConnections((error, count) => (error ? reject(error) : resolve(count))),
        ),
      (count) => count > 0,
    );
    await app.close();
    await eventually(
      () => unused.closed,
      (closed) => closed,
    );
  });
});

describe("errors", () => {
  it("answers an unknown route and a bug in the contract's shape", async () => {
    const app = await build(HealthyModule);
    const missing = await get(app, "/nowhere");
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "NOT_FOUND", status: 404 });
    const broken = await get(app, "/demo/broken");
    expect(broken.statusCode).toBe(500);
    expect(broken.json()).toMatchObject({
      code: "INTERNAL",
      data: { requestId: broken.headers["x-request-id"] },
    });
    expect(broken.body).not.toContain("a bug");
  });
});

describe("the dependency check", () => {
  it("fails while the database can't be reached, and readiness doesn't", async () => {
    const app = await build(DatabaseDownModule, { loadShedding: false });
    expect((await get(app, "/health/live")).statusCode).toBe(200);
    // A shared dependency down must not take every pod out of rotation at once.
    expect((await get(app, "/health/ready")).statusCode).toBe(200);
    const dependencies = await get(app, "/health/dependencies");
    expect(dependencies.statusCode).toBe(503);
    expect(dependencies.json()).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("fails for a dependency the service never registered", async () => {
    const app = await build(UnregisteredModule, { loadShedding: false });
    expect((await get(app, "/health/dependencies")).statusCode).toBe(503);
  });
});

describe("load shedding", () => {
  it("answers 503 with when to come back once the heap nears the container's memory", async () => {
    // A container this small is over its limit at once.
    vi.spyOn(process, "constrainedMemory").mockReturnValue(1024);
    const app = await build(UnregisteredModule);
    const response = await eventually(
      () => get(app, "/health/live"),
      (current) => current.statusCode === 503,
      { timeout: 5_000 },
    );
    expect(response.headers["retry-after"]).toBe("5");
    expect(response.json()).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
});
