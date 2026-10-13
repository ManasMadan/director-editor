import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { describe, expect, it } from "vitest";
import { textDirection } from "@/i18n/request";
import { renderHtml, request } from "../../test/next-server";
import RootLayout, { generateMetadata } from "./layout";

// The server render never navigates; the providers only need a router to exist.
const nothing = () => undefined;
const router = {
  push: nothing,
  replace: nothing,
  refresh: nothing,
  back: nothing,
  forward: nothing,
  prefetch: nothing,
  bfcacheId: "test",
};
const render = async () =>
  renderHtml(
    <AppRouterContext value={router}>
      {await RootLayout({ children: <p>page content</p> })}
    </AppRouterContext>,
  );

describe("the root layout", () => {
  it("renders the page in the request's language, inside the app shell", async () => {
    request.cookies.set("locale", "es");
    request.headers.set("x-nonce", "abc123");
    const html = await render();
    expect(html).toMatch(/<html lang="es" dir="ltr"/);
    expect(html).toContain("--font-geist-sans");
    expect(html).toContain("<main");
    expect(html).toContain("page content");
    // next-themes' inline script runs under the proxy's CSP nonce.
    expect(html).toContain('nonce="abc123"');
  });

  it("renders without a nonce when the proxy didn't set one", async () => {
    const html = await render();
    expect(html).toMatch(/<html lang="en"/);
    expect(html).not.toContain("nonce=");
  });

  it("titles pages after the site", async () => {
    expect(await generateMetadata()).toEqual({
      title: { default: "Boilerplate", template: "%s · Boilerplate" },
      description: expect.any(String),
    });
  });

  it("writes right-to-left languages right to left", () => {
    expect(textDirection("ar")).toBe("rtl");
    expect(textDirection("en")).toBe("ltr");
  });
});
