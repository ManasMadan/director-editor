import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authClientPlugins, createAppAuthClient } from "./client";

// The API's auth endpoints, as far as these calls see them: no session, and a password
// sign-in that needs a second factor.
let server: Server;
let baseUrl: string;
const paths: string[] = [];
beforeAll(async () => {
  server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        request.url === "/api/auth/sign-in/email"
          ? { twoFactorRedirect: true, twoFactorMethods: ["totp"] }
          : null,
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const signIn = { email: "ada@example.com", password: "correct horse battery" };

describe("the auth client", () => {
  it("talks to the API's auth endpoints at the origin given", async () => {
    const auth = createAppAuthClient({ baseUrl });
    const { data } = await auth.getSession();
    expect(data).toBeNull();
    expect(paths.at(-1)).toBe("/api/auth/get-session");
  });

  it("says when a sign-in needs a second factor", async () => {
    const onTwoFactorRequired = vi.fn();
    const auth = createAppAuthClient({ baseUrl, onTwoFactorRequired });
    await auth.signIn.email(signIn);
    expect(onTwoFactorRequired).toHaveBeenCalledOnce();
    // Without a callback the answer is left to the caller.
    const { data } = await createAppAuthClient({ baseUrl }).signIn.email(signIn);
    expect(data).toMatchObject({ twoFactorRedirect: true });
  });

  it("calls the page's own origin when none is given", async () => {
    vi.stubGlobal("location", { origin: baseUrl });
    try {
      const before = paths.length;
      await createAppAuthClient().getSession();
      expect(paths.slice(before)).toEqual(["/api/auth/get-session"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("gives mobile the same plugins, so both expose the same methods", () => {
    expect(authClientPlugins().map((plugin) => plugin.id)).toEqual(
      authClientPlugins({ onTwoFactorRequired: () => undefined }).map((plugin) => plugin.id),
    );
  });
});
