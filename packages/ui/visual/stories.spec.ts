/** One screenshot per story and theme, after the story (and its play function) finished. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

interface IndexEntry {
  id: string;
  type: "story" | "docs";
}

const index = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "storybook-static", "index.json"), "utf8"),
) as { entries: Record<string, IndexEntry> };
const stories = Object.values(index.entries).filter((entry) => entry.type === "story");

for (const { id } of stories) {
  for (const theme of ["light", "dark"] as const) {
    test(`${id} (${theme})`, async ({ page }) => {
      await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`);
      // Wait until the story rendered and its play function (if any) finished.
      await page.waitForFunction(() => {
        const preview = (
          window as { __STORYBOOK_PREVIEW__?: { currentRender?: { phase?: string } } }
        ).__STORYBOOK_PREVIEW__;
        return preview?.currentRender?.phase === "finished";
      });
      await expect(page).toHaveScreenshot(`${id}-${theme}.png`);
    });
  }
}
