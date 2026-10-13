import { withThemeByClassName } from "@storybook/addon-themes";
import type { Preview } from "@storybook/react-vite";
import "../src/styles/globals.css";

const preview: Preview = {
  decorators: [
    // The `dark` class on <html>, as next-themes sets it in the app.
    withThemeByClassName({
      themes: { light: "", dark: "dark" },
      // The story tests run every story in both themes (vitest.config.ts).
      defaultTheme: import.meta.env.VITE_STORY_THEME ?? "light",
      parentSelector: "html",
    }),
  ],
  parameters: {
    layout: "centered",
    // Accessibility violations fail the story's test, not just show in the panel.
    a11y: { test: "error" },
  },
};

export default preview;
