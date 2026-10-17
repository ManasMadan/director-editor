import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MINUTE_MS, SECOND_MS } from "@repo/contracts/time";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGoogleAuth, metadataServerAuth } from "./google-auth";

// A stand-in for the GCE metadata server: numbered tokens, an hour each.
let server: Server;
let url: string;
let issued: number;
let status: number;
let lastHeaders: IncomingHttpHeaders;
beforeAll(async () => {
  server = createServer((request, response) => {
    lastHeaders = request.headers;
    issued += 1;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ access_token: `token-${issued}`, expires_in: 3600, token_type: "Bearer" }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  url = `http://127.0.0.1:${port}/computeMetadata/v1/instance/service-accounts/default/token`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  issued = 0;
  status = 200;
});

describe("the metadata server's token", () => {
  it("is asked for as GCE requires, and reused until a minute before it expires", async () => {
    let clock = 0;
    const auth = metadataServerAuth(url, () => clock);
    expect(await auth.accessToken()).toBe("token-1");
    expect(lastHeaders["metadata-flavor"]).toBe("Google");
    clock = 59 * MINUTE_MS - SECOND_MS;
    expect(await auth.accessToken()).toBe("token-1");
    clock = 59 * MINUTE_MS;
    expect(await auth.accessToken()).toBe("token-2");
  });

  it("fails when the metadata server refuses", async () => {
    status = 404;
    await expect(metadataServerAuth(url).accessToken()).rejects.toThrow("answered 404");
  });
});

describe("a pasted token", () => {
  it("is used as it is, in place of the metadata server", async () => {
    expect(await createGoogleAuth("ya29.local").accessToken()).toBe("ya29.local");
    expect(createGoogleAuth(undefined)).toEqual({ accessToken: expect.any(Function) });
  });
});
