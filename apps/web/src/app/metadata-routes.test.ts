import { describe, expect, it } from "vitest";
import manifest from "./manifest";
import robots from "./robots";
import sitemap from "./sitemap";

/** The site's origin, WEB_URL in the tests' environment (a stack moves its port). */
const SITE = process.env.WEB_URL;

describe("metadata routes", () => {
  it("installs as an app that opens on the dashboard", () => {
    expect(manifest()).toMatchObject({ start_url: "/dashboard", display: "standalone" });
  });

  it("keeps crawlers out of signed-in pages and auth flows, and points them at the sitemap", () => {
    const rules = robots();
    expect(rules.sitemap).toBe(`${SITE}/sitemap.xml`);
    expect(rules.rules).toMatchObject({
      allow: "/",
      disallow: expect.arrayContaining(["/dashboard", "/sign-"]),
    });
  });

  it("lists the public pages on this site's origin", () => {
    expect(sitemap().map((entry) => entry.url)).toEqual([
      `${SITE}/`,
      `${SITE}/terms`,
      `${SITE}/privacy`,
    ]);
  });
});
