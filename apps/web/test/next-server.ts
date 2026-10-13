/**
 * Server-side tests (the `unit` project): the request Next.js would be rendering. Next's
 * `cookies()` and `headers()` only work inside its own server, so they read `request`
 * here; next-intl's server functions run for real, through src/i18n/request.ts, the way
 * Next's plugin wires them (see the aliases in vitest.config.ts).
 *
 *   request.cookies.set("locale", "es");
 *   const html = renderToStaticMarkup(await NotFound());
 */
import type { ReactNode } from "react";
import { prerender } from "react-dom/static";
import { beforeEach, vi } from "vitest";

export const request = { cookies: new Map<string, string>(), headers: new Headers() };

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      request.cookies.has(name) ? { name, value: request.cookies.get(name) } : undefined,
    has: (name: string) => request.cookies.has(name),
  }),
  // With the cookies in their header, as a real request has them.
  headers: async () => {
    const headers = new Headers(request.headers);
    const cookie = [...request.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    if (cookie) {
      headers.set("cookie", cookie);
    }
    return headers;
  },
}));

// Next's compiler replaces next/font calls with the font's generated class names.
vi.mock("next/font/local", () => ({
  default: (options: { variable: string }) => ({ className: "", variable: options.variable }),
}));

beforeEach(() => {
  request.cookies.clear();
  request.headers = new Headers();
});

/** The HTML a server render of `node` produces, async server components included. */
export async function renderHtml(node: ReactNode) {
  const { prelude } = await prerender(node);
  return new Response(prelude).text();
}
