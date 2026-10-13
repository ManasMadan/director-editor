import { describe, expect, it } from "vitest";
import { renderHtml, request } from "../../test/next-server";
import NotFound from "./not-found";
import Home from "./page";

describe("server pages", () => {
  it("renders the 404 page in the request's language", async () => {
    request.cookies.set("locale", "es");
    const html = await renderHtml(await NotFound());
    expect(html).toContain('href="/"');
  });

  it("sends signed-in visitors of the home page to the dashboard", async () => {
    request.cookies.set("better-auth.session_token", "x");
    expect(await renderHtml(await Home())).toContain('href="/dashboard"');
    request.cookies.clear();
    expect(await renderHtml(await Home())).toContain('href="/sign-up"');
  });
});
