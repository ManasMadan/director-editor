import { describe, expect, it } from "vitest";
import { SiteChrome } from "@/modules/shell";
import { renderPage } from "../render";

const chrome = (
  <SiteChrome header={<p>site header</p>} footer={<footer>site footer</footer>}>
    <p>page content</p>
  </SiteChrome>
);

describe("the site chrome", () => {
  it("puts the header above the page and the footer below it, outside the main content", async () => {
    const page = await renderPage(chrome, { url: "/settings" });
    await expect.element(page.getByText("site header")).toBeVisible();
    await expect.element(page.getByRole("main")).toHaveTextContent("page content");
    await expect.element(page.getByRole("contentinfo")).toHaveTextContent("site footer");
    const main = page.getByRole("main").element();
    expect(main.contains(page.getByRole("contentinfo").element())).toBe(false);
    expect(page.getByRole("main").element().className).not.toContain("bg-studio");
  });

  it("puts the library, header and all, on Director's dark stage", async () => {
    const page = await renderPage(chrome, { url: "/library" });
    await expect.element(page.getByText("site header")).toBeVisible();
    await expect.element(page.getByRole("main")).toHaveTextContent("page content");
    expect(page.getByRole("main").element().parentElement?.className).toContain("bg-studio");
  });

  it.each(["/director/kJQP7kiw5Fk", "/director/kJQP7kiw5Fk/shoot"])(
    "leaves %s the whole screen",
    async (url) => {
      const page = await renderPage(chrome, { url });
      await expect.element(page.getByRole("main")).toHaveTextContent("page content");
      expect(page.getByText("site header").query()).toBeNull();
      expect(page.getByText("site footer").query()).toBeNull();
    },
  );
});
