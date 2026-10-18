/**
 * Runs before every page render (Next.js "proxy", formerly middleware). It only shapes
 * the response; it never touches data:
 *
 * 1. A per-request nonce for the Content-Security-Policy, so the policy can forbid
 *    inline scripts except Next's own (which receive the nonce).
 * 2. Early redirects based on whether a session cookie is present: signed-out visitors
 *    to app pages go to sign-in, signed-in visitors to auth pages go to the library.
 *    A present cookie can still be expired or revoked; the API rejects it and the client
 *    then signs out (packages/client). This check is only about not flashing the wrong page.
 */
import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { contentSecurityPolicy } from "@/lib/csp";
import { APP_PATHS, GUEST_PATHS, HOME_PATH, matchesPath } from "@/lib/routes";

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  // Only whether better-auth's session cookie is there (any of its names); the API
  // decides whether the session is valid.
  const signedIn = getSessionCookie(request) !== null;

  if (!signedIn && matchesPath(pathname, APP_PATHS)) {
    const url = new URL("/sign-in", request.url);
    url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }
  if (signedIn && matchesPath(pathname, GUEST_PATHS)) {
    return NextResponse.redirect(new URL(HOME_PATH, request.url));
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy({
    nonce,
    development: process.env.NODE_ENV === "development",
    storageOrigin: env.STORAGE_ORIGIN,
  }).join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  // Everything except static assets and the API paths the gateway (or dev rewrites) forwards.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sw\\.js|rpc|api|docs|healthz|\\.well-known|.*\\.(?:png|svg|jpg|ico|webmanifest|txt)$).*)",
  ],
};
