import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "./manifest";
import robots from "./robots";
import sitemap from "./sitemap";

/** Where Next serves files from as they are (apps/web/public). */
const PUBLIC = join(import.meta.dirname, "../../public");

/** The site's origin, WEB_URL in the tests' environment (a stack moves its port). */
const SITE = process.env.WEB_URL;

describe("metadata routes", () => {
  it("installs as an app that opens on the library", () => {
    expect(manifest()).toMatchObject({ start_url: "/library", display: "standalone" });
  });

  it("gives the installed app its icon, at the sizes launchers ask for", () => {
    const icons = manifest().icons ?? [];
    expect(icons.map((icon) => [icon.sizes, icon.purpose])).toEqual([
      ["192x192", "any"],
      ["512x512", "any"],
      ["512x512", "maskable"],
    ]);
    for (const icon of icons) {
      expect(existsSync(join(PUBLIC, icon.src))).toBe(true);
    }
  });

  it("keeps crawlers out of signed-in pages and auth flows, and points them at the sitemap", () => {
    const rules = robots();
    expect(rules.sitemap).toBe(`${SITE}/sitemap.xml`);
    expect(rules.rules).toMatchObject({
      allow: "/",
      disallow: expect.arrayContaining(["/library", "/sign-"]),
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
