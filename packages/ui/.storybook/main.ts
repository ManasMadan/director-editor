/**
 * Storybook for the shared components: `bun run storybook` (http://localhost:6006).
 * Every story is also a test (`bun run test:stories`): it renders in a real browser, runs
 * its play function and fails on accessibility violations (axe); and a screenshot
 * (`bun run test:visual`) in light and dark.
 */

import type { StorybookConfig } from "@storybook/react-vite";
import tailwindcss from "@tailwindcss/vite";

const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  stories: ["../src/**/*.stories.tsx"],
  addons: ["@storybook/addon-a11y", "@storybook/addon-themes", "@storybook/addon-vitest"],
  core: { disableTelemetry: true },
  viteFinal: async (vite) => ({ ...vite, plugins: [...(vite.plugins ?? []), tailwindcss()] }),
};

export default config;
