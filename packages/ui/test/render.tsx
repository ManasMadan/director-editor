/// <reference types="vite/client" />
/**
 * Renders a component for a plain browser test (a `*.test.tsx` in src), removed again when
 * the test finishes. Query it with `page` from "vitest/browser" and `expect.element`,
 * which wait for what they look for.
 */
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { onTestFinished } from "vitest";
import "../src/styles/globals.css";

export function render(ui: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  root.render(ui);
  onTestFinished(() => {
    root.unmount();
    container.remove();
  });
  return container;
}
