import { describe, expect, it } from "vitest";
import { SiteChrome } from "@/modules/shell";
import { renderPage } from "../render";

const chrome = (
  <SiteChrome header={<p>site header</p>}>
    <p>page content</p>
  </SiteChrome>
);

describe("the site chrome", () => {
  it("puts the header above the page", async () => {
    const page = await renderPage(chrome, { url: "/dashboard" });
    await expect.element(page.getByText("site header")).toBeVisible();
    await expect.element(page.getByRole("main")).toHaveTextContent("page content");
  });

  it.each(["/home", "/shorts/kJQP7kiw5Fk", "/director/kJQP7kiw5Fk"])(
    "leaves %s the whole screen",
    async (url) => {
      const page = await renderPage(chrome, { url });
      await expect.element(page.getByRole("main")).toHaveTextContent("page content");
      expect(page.getByText("site header").query()).toBeNull();
    },
  );
});
