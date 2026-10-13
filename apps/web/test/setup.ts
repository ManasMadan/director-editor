/** Runs around every browser test (vitest.config.ts `setupFiles`). */
import { afterEach, beforeEach } from "vitest";
import { commands } from "vitest/browser";
import { cleanup } from "./render";

// The test runner's own address, which renderPage replaces with the page's.
const testerUrl = window.location.href;

beforeEach(() => commands.startTest());

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", testerUrl);
});
