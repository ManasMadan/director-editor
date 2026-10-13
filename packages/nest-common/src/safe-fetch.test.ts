import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "./errors";
import { guardedLookup, isPublicAddress, safeFetch } from "./safe-fetch";

describe("isPublicAddress", () => {
  it.each([
    ["8.8.8.8", true],
    ["2606:4700:4700::1111", true],
    ["127.0.0.1", false],
    ["10.1.2.3", false],
    ["172.16.0.1", false],
    ["192.168.1.1", false],
    ["169.254.169.254", false],
    ["100.64.0.1", false],
    ["0.0.0.0", false],
    ["::1", false],
    ["fd00::1", false],
    ["fe80::1", false],
    ["::ffff:127.0.0.1", false],
    ["::ffff:8.8.8.8", true],
    ["not-an-ip", false],
  ])("%s → %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});

describe("safeFetch", () => {
  let server: Server;
  let base: string;
  let hitElsewhere = 0;

  beforeAll(async () => {
    // A Map, and only a function called: a request for `constructor` must find nothing.
    const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void>([
      [
        "/redirect-internal",
        (_, res) =>
          res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end(),
      ],
      ["/redirect-home", (_, res) => res.writeHead(307, { location: "/elsewhere" }).end()],
      [
        "/elsewhere",
        (_, res) => {
          hitElsewhere++;
          res.end("followed");
        },
      ],
      [
        "/echo",
        (req, res) => {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });
          req.on("end", () => res.end(`${req.method} ${req.headers["x-test"]} ${body}`));
        },
      ],
      ["/loop", (_, res) => res.writeHead(302, { location: "/loop" }).end()],
      ["/big", (_, res) => res.end("x".repeat(2_000))],
    ]);
    server = createServer((req, res) => {
      const route = routes.get(req.url ?? "");
      if (typeof route === "function") {
        route(req, res);
      } else {
        res.end("ok");
      }
    });
    // Both loopbacks: `localhost` may resolve to either, or both.
    await new Promise<void>((resolve) => server.listen(0, "::", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("refuses loopback and metadata destinations", async () => {
    await expect(safeFetch(`${base}/`, { allowHttp: true })).rejects.toBeInstanceOf(AppError);
    await expect(safeFetch("http://169.254.169.254/", { allowHttp: true })).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("checks the addresses a hostname resolves to, and connects to the one it checked", async () => {
    const named = base.replace("127.0.0.1", "localhost");
    await expect(safeFetch(`${named}/`, { allowHttp: true })).rejects.toMatchObject({
      code: "DESTINATION_NOT_ALLOWED",
      params: { hostname: "localhost" },
    });
    await expect(
      safeFetch(`${named}/`, { allowHttp: true, allowedPrivateAddresses: ["127.0.0.1", "::1"] }),
    ).resolves.toMatchObject({ status: 200, body: "ok" });
    // A name that doesn't resolve fails as the lookup did.
    await expect(safeFetch("http://unknown-host.invalid/", { allowHttp: true })).rejects.toThrow(
      /fetch failed/,
    );
  });

  it("requires https unless http is explicitly allowed", async () => {
    await expect(safeFetch("http://example.com/")).rejects.toMatchObject({
      code: "DESTINATION_NOT_ALLOWED",
    });
  });

  it("answers with the redirect itself when told not to follow it", async () => {
    const local = { allowHttp: true, allowedPrivateAddresses: ["127.0.0.1"] };
    const stopped = await safeFetch(`${base}/redirect-home`, {
      ...local,
      method: "POST",
      body: "signed",
      followRedirects: false,
    });
    expect(stopped.status).toBe(307);
    expect(hitElsewhere).toBe(0);
    expect((await safeFetch(`${base}/redirect-home`, local)).body).toBe("followed");
  });

  it("re-checks every redirect hop", async () => {
    // The first hop (the local test server) is explicitly allowed; the redirect target,
    // the cloud metadata address, is not.
    await expect(
      safeFetch(`${base}/redirect-internal`, {
        allowHttp: true,
        allowedPrivateAddresses: ["127.0.0.1"],
      }),
    ).rejects.toMatchObject({
      code: "DESTINATION_NOT_ALLOWED",
      params: { hostname: "169.254.169.254" },
    });
  });

  it("sends the method, headers and body it's given", async () => {
    const response = await safeFetch(`${base}/echo`, {
      allowHttp: true,
      allowedPrivateAddresses: ["127.0.0.1"],
      method: "PUT",
      headers: { "x-test": "yes" },
      body: "payload",
    });
    expect(response.body).toBe("PUT yes payload");
  });

  it("gives up on an endpoint that keeps redirecting", async () => {
    await expect(
      safeFetch(`${base}/loop`, { allowHttp: true, allowedPrivateAddresses: ["127.0.0.1"] }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
  });

  it("caps the response size", async () => {
    await expect(
      safeFetch(`${base}/big`, {
        allowHttp: true,
        allowedPrivateAddresses: ["127.0.0.1"],
        maxResponseBytes: 1_000,
      }),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    await expect(
      safeFetch(`${base}/`, { allowHttp: true, allowedPrivateAddresses: ["127.0.0.1"] }),
    ).resolves.toMatchObject({
      status: 200,
      body: "ok",
    });
  });
});

describe("guardedLookup", () => {
  const both = async () => [
    { address: "127.0.0.1", family: 4 },
    { address: "::1", family: 6 },
  ];
  const resolve = (all: boolean, allowlist: string[] = []) =>
    new Promise<unknown[]>((done) => {
      guardedLookup(allowlist, both)("localhost", { all }, (...args: unknown[]) => done(args));
    });

  it("answers in the shape it was asked for, with the first address", async () => {
    const allowlist = ["127.0.0.1", "::1"];
    expect(await resolve(true, allowlist)).toEqual([null, [{ address: "127.0.0.1", family: 4 }]]);
    expect(await resolve(false, allowlist)).toEqual([null, "127.0.0.1", 4]);
  });

  it("refuses a name unless every address it answers with is permitted", async () => {
    expect((await resolve(false))[0]).toMatchObject({ code: "DESTINATION_NOT_ALLOWED" });
    // One public-or-allowed address isn't enough: the other is where it could go next.
    expect((await resolve(false, ["127.0.0.1"]))[0]).toMatchObject({
      code: "DESTINATION_NOT_ALLOWED",
    });
  });

  it("refuses a name with no addresses at all", async () => {
    const [error] = await new Promise<unknown[]>((done) => {
      guardedLookup([], async () => [])("nothing.test", { all: false }, (...args: unknown[]) =>
        done(args),
      );
    });
    expect(error).toMatchObject({ code: "DESTINATION_NOT_ALLOWED" });
  });
});
