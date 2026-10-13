import { timeoutManager } from "@tanstack/react-query";

// .env.example's values (EXPO_PUBLIC_API_URL), the same for every test run. Required, not
// imported: it runs on Node, and the app is type-checked with React Native's types only.
const { applyTestEnvironment } = require("@repo/testing/environment");
applyTestEnvironment();

// Native modules that have no JavaScript fallback in tests. Secure storage keeps what's
// written, as the Keychain would: the auth client stores the session cookie there.
jest.mock("expo-secure-store", () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    getItemAsync: async (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    setItemAsync: async (key: string, value: string) => void items.set(key, value),
    deleteItemAsync: async (key: string) => void items.delete(key),
  };
});
// A store build embeds app.config.ts as its manifest (the URL scheme, the version); tests
// have none.
jest.mock("expo-constants", () => {
  const actual = jest.requireActual("expo-constants");
  const expoConfig = jest.requireActual("./app.config").default({ config: {} });
  const executionEnvironment = actual.ExecutionEnvironment.Standalone;
  return {
    ...actual,
    __esModule: true,
    default: { ...actual.default, expoConfig, executionEnvironment },
  };
});

// Passkeys use the device's own prompt: tests say what the person did there.
jest.mock("react-native-passkeys", () => ({
  isSupported: jest.fn(() => true),
  get: jest.fn(),
  create: jest.fn(),
}));

// Push needs a real device: tests run like a simulator unless they say otherwise.
jest.mock("expo-device", () => ({ isDevice: false }));
jest.mock("expo-notifications", () => ({ setNotificationHandler: jest.fn() }));

// Unit tests never reach a network. better-auth's client keeps the fetch it finds when it's
// created, so a test answers requests by giving this one an implementation (fakeApi in
// test/app.ts), never by replacing fetch.
globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
  throw new Error(`No fake answer for ${String(input)}`);
});

// React Query keeps each unused query for five minutes (gcTime) on a timer. In a test
// process nothing needs them after the last test, so its timers don't keep Jest alive.
// (Jest runs on Node, whose timers can be unref'd; the app's types are React Native's.)
const unref = <T>(timer: T): T => {
  (timer as { unref?: () => void }).unref?.();
  return timer;
};
timeoutManager.setTimeoutProvider({
  setTimeout: (callback, delay) => unref(setTimeout(callback, delay)),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (callback, delay) => unref(setInterval(callback, delay)),
  clearInterval: (id) => clearInterval(id),
});
