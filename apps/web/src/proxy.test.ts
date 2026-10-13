import { getRedirectUrl, unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config, proxy } from "./proxy";

const SITE = "http://localhost:3000";
const request = (path: string, signedIn = false) =>
  new NextRequest(`${SITE}${path}`, {
    headers: signedIn ? { cookie: "better-auth.session_token=abc" } : {},
  });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the proxy", () => {
  it("sends signed-out visitors of app pages to sign in, and back afterwards", () => {
    expect(getRedirectUrl(proxy(request("/settings/security?tab=2")))).toBe(
      `${SITE}/sign-in?next=%2Fsettings%2Fsecurity%3Ftab%3D2`,
    );
  });

  it("sends signed-in visitors of auth pages to the dashboard", () => {
    expect(getRedirectUrl(proxy(request("/sign-in", true)))).toBe(`${SITE}/dashboard`);
    // Over HTTPS better-auth names the cookie with the __Secure- prefix.
    const secure = new NextRequest(`${SITE}/sign-in`, {
      headers: { cookie: "__Secure-better-auth.session_token=abc" },
    });
    expect(getRedirectUrl(proxy(secure))).toBe(`${SITE}/dashboard`);
  });

  it("keeps auth pages reachable for an app's OAuth request, signed in or not", () => {
    const response = proxy(request("/sign-in?client_id=app&sig=abc", true));
    expect(getRedirectUrl(response)).toBeNull();
  });

  it("renders everything else with a nonce'd Content-Security-Policy", () => {
    const first = proxy(request("/"));
    const second = proxy(request("/dashboard", true));
    const csp = first.headers.get("content-security-policy") ?? "";
    expect(getRedirectUrl(first)).toBeNull();
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'(;|$)/);
    // Uploads go to object storage (STORAGE_ORIGIN in .env.example, moved by a stack).
    expect(csp).toContain(
      `connect-src 'self' https://challenges.cloudflare.com ${process.env.STORAGE_ORIGIN}`,
    );
    // A fresh nonce per request, handed to the page render.
    expect(second.headers.get("content-security-policy")).not.toBe(csp);
    expect(first.headers.get("x-middleware-request-x-nonce")).toBe(
      /'nonce-([^']+)'/.exec(csp)?.[1],
    );
  });

  it("lets development's hot reloading eval, and leaves storage out when files are off", async () => {
    const storage = String(process.env.STORAGE_ORIGIN);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("STORAGE_ORIGIN", "");
    const { proxy: fresh } = await import("./proxy");
    const csp = fresh(request("/")).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("'strict-dynamic' 'unsafe-eval'");
    expect(csp).not.toContain(storage);
  });

  it.each([
    ["/dashboard", true],
    ["/rpc/todo/list", false],
    ["/api/auth/get-session", false],
    ["/_next/static/chunk.js", false],
    ["/sw.js", false],
    ["/healthz", false],
    ["/logo.png", false],
  ])("runs for %s: %s", (url, matches) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(matches);
  });
});
