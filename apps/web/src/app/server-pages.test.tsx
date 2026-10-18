import { describe, expect, it } from "vitest";
import { renderHtml, request } from "../../test/next-server";
import NotFound from "./not-found";
import Home from "./page";

describe("server pages", () => {
  it("renders the 404 page in the request's language", async () => {
    request.cookies.set("locale", "en");
    const html = await renderHtml(await NotFound());
    expect(html).toContain('href="/"');
  });

  it("offers signed-in visitors of the home page Director, and others the demo", async () => {
    request.cookies.set("better-auth.session_token", "x");
    expect(await renderHtml(await Home())).toContain('href="/library"');
    request.cookies.clear();
    expect(await renderHtml(await Home())).toContain('href="/sign-in?demo=1"');
  });
});
