/**
 * Screenshots of every story, in light and dark, compared with the committed baselines
 * (visual/__screenshots__). Rendering differs between operating systems (fonts,
 * antialiasing), so these always run in the Playwright Docker image, locally and in CI:
 *
 *   bun run test:visual            compare
 *   bun run test:visual:update     accept the current rendering as the new baselines
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  fullyParallel: true,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:6007",
    viewport: { width: 640, height: 480 },
    deviceScaleFactor: 1,
  },
  expect: {
    toHaveScreenshot: { animations: "disabled", caret: "hide", maxDiffPixelRatio: 0.002 },
  },
  webServer: { command: "node serve.mjs", url: "http://localhost:6007/index.json" },
});
