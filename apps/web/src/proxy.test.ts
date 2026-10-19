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

  it("sends signed-in visitors of auth pages to the library", () => {
    expect(getRedirectUrl(proxy(request("/sign-in", true)))).toBe(`${SITE}/library`);
    // Over HTTPS better-auth names the cookie with the __Secure- prefix.
    const secure = new NextRequest(`${SITE}/sign-in`, {
      headers: { cookie: "__Secure-better-auth.session_token=abc" },
    });
    expect(getRedirectUrl(proxy(secure))).toBe(`${SITE}/library`);
  });

  it("renders everything else with a nonce'd Content-Security-Policy", () => {
    const first = proxy(request("/"));
    const second = proxy(request("/library", true));
    const csp = first.headers.get("content-security-policy") ?? "";
    expect(getRedirectUrl(first)).toBeNull();
    // Only this site's scripts, and the ones its nonce'd bootstrap loads: no WebAssembly.
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'(;|$)/);
    // Uploads go to object storage (STORAGE_ORIGIN in .env.example, moved by a stack).
    expect(csp).toContain(
      `connect-src 'self' https://challenges.cloudflare.com ${process.env.STORAGE_ORIGIN}`,
    );
    // Takes play back from memory and from storage; shorts in YouTube's privacy embed.
    expect(csp).toContain(`media-src 'self' blob: ${process.env.STORAGE_ORIGIN}`);
    expect(csp).toContain(
      "frame-src https://challenges.cloudflare.com https://www.youtube-nocookie.com;",
    );
    // A fresh nonce per request, handed to the page render.
    expect(second.headers.get("content-security-policy")).not.toBe(csp);
    expect(first.headers.get("x-middleware-request-x-nonce")).toBe(
      /'nonce-([^']+)'/.exec(csp)?.[1],
    );
  });

  it("allows Turnstile what Cloudflare documents for it, and nothing broader", () => {
    const csp = proxy(request("/sign-in")).headers.get("content-security-policy") ?? "";
    const directive = (name: string) =>
      csp
        .split("; ")
        .find((part) => part.startsWith(`${name} `))
        ?.split(" ")
        .slice(1) ?? [];
    // developers.cloudflare.com/turnstile/reference/content-security-policy: its script
    // (here through the nonce'd loader and 'strict-dynamic', which Turnstile supports),
    // its frame, and this origin for pre-clearance.
    expect(directive("script-src")).toEqual(expect.arrayContaining(["'strict-dynamic'"]));
    expect(directive("frame-src")).toContain("https://challenges.cloudflare.com");
    expect(directive("connect-src")).toContain("'self'");
    // The `data:` fetch a browser console reports from the challenge runs in Cloudflare's
    // own frame, under the policy Cloudflare serves it with; this page's can't change it.
    expect(directive("connect-src")).not.toContain("data:");
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
    ["/library", true],
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
