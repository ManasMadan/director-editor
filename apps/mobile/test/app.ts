/**
 * The whole app in a test: its real routes, opened at a URL, talking to the fake API
 * (fake-api.ts).
 *
 *   const calls = fakeApi();
 *   const app = await openApp("/");
 *   expect(app.pathname()).toBe("/sign-in");
 */
import { act, configure } from "@testing-library/react-native";
import { getMockContext, renderRouter } from "expo-router/testing-library";
import { authClient } from "../src/lib/auth-client";

export * from "./fake-api";

/**
 * The auth client keeps the session between renders, as it does in the app: this starts a
 * test from what the fake server says, not what the previous test left. (Through `value`:
 * `get()` on a store nothing listens to leaves a timer running.)
 */
export const loadSession = () => act(() => authClient.$store.atoms.session?.value?.refetch());

// Every route, and so the whole app and its dependencies, is loaded here, when the test file
// imports this, outside any test's timeout: on a cold Babel cache (a fresh CI runner) that
// compiles thousands of files, which took the first test of each worker past its timeout.
const routes = getMockContext("src/app");
for (const route of routes.keys()) {
  routes(route);
}

// The first render of a file still takes a few seconds on a busy machine.
jest.setTimeout(30_000);
// findBy* and waitFor wait for what a screen does after a fake request answers: a second
// (the default) isn't enough when turbo runs every package's tests at once.
configure({ asyncUtilTimeout: 10_000 });

/** Opens the app at `url`, as a link or a cold start would. */
export async function openApp(url = "/") {
  await loadSession();
  // Relative to the working directory: Jest runs in apps/mobile.
  const app = renderRouter("src/app", { initialUrl: url });
  // renderRouter loads the routes under fake timers; the clients need real ones.
  jest.useRealTimers();
  await app;
  // Not the render result itself, which is a promise (awaiting it would drop these).
  return {
    pathname: () => app.getPathname(),
    pathnameWithParams: () => app.getPathnameWithParams(),
  };
}
