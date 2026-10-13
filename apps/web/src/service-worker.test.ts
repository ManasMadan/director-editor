/**
 * The push service worker (public/sw.js), its handlers run against a stand-in for the
 * worker's global scope: what a pushed message shows, and where clicking it goes. The
 * e2e suite drives the same file in a real browser (e2e/push.spec.ts,
 * e2e/service-worker.spec.ts).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://app.test";

type Handler = (event: object) => void;
const handlers = new Map<string, Handler>();
const showNotification = vi.fn(async (_title: string, _options: object) => undefined);
const openWindow = vi.fn(async (_url: string) => null);
const matchAll = vi.fn(async (_options: object): Promise<Window[]> => []);

beforeAll(async () => {
  vi.stubGlobal("self", {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    registration: { showNotification },
    clients: { matchAll, openWindow },
  });
  await import(/* @vite-ignore */ new URL("../public/sw.js", import.meta.url).pathname);
});

beforeEach(() => {
  vi.clearAllMocks();
  matchAll.mockResolvedValue([]);
});

/** Fires `type` at the worker; the promise it asked to wait for, if any. */
function fire(type: string, event: object) {
  const waited: Promise<unknown>[] = [];
  handlers.get(type)?.({
    ...event,
    waitUntil: (promise: Promise<unknown>) => waited.push(promise),
  });
  return waited;
}

/** A browser window of the site (or another origin) as `clients.matchAll` gives it. */
type Window = { url: string; focus: () => Promise<Window>; navigate: (url: string) => unknown };
function window(url: string) {
  const client: Window = {
    url,
    focus: vi.fn(async () => client),
    navigate: vi.fn(async () => client),
  };
  return client;
}

describe("a push", () => {
  const push = (data: { json: () => unknown } | null) => fire("push", { data });

  it("shows the message's title, body and tag, keeping its link for the click", async () => {
    const waited = push({
      json: () => ({ title: "Reminder", body: "Water the plants", link: "/todos", tag: "t" }),
    });
    await Promise.all(waited);
    expect(waited).toHaveLength(1);
    expect(showNotification).toHaveBeenCalledWith("Reminder", {
      body: "Water the plants",
      tag: "t",
      data: { link: "/todos" },
    });
  });

  it("leaves out what isn't text, and links to the home page without a link", async () => {
    await Promise.all(push({ json: () => ({ title: "Hi", body: 1, tag: {}, link: null }) }));
    expect(showNotification).toHaveBeenCalledWith("Hi", {
      body: undefined,
      tag: undefined,
      data: { link: "/" },
    });
  });

  it.each([
    ["no data", null],
    ["data that isn't JSON", { json: () => JSON.parse("not json") }],
    ["no title", { json: () => ({ body: "no title" }) }],
    ["a title that isn't text", { json: () => ({ title: 7 }) }],
  ])("shows nothing for %s", (_case, data) => {
    expect(push(data)).toEqual([]);
    expect(showNotification).not.toHaveBeenCalled();
  });
});

describe("a click on a notification", () => {
  function click(data?: { link?: string }) {
    const close = vi.fn();
    const waited = fire("notificationclick", { notification: { data, close } });
    return { close, waited };
  }

  it("brings the site's open window forward and takes it to the link", async () => {
    const other = window("https://elsewhere.test/");
    const site = window(`${ORIGIN}/settings`);
    matchAll.mockResolvedValue([other, site]);
    const { close, waited } = click({ link: "/todos?id=1" });
    await Promise.all(waited);
    expect(close).toHaveBeenCalled();
    expect(matchAll).toHaveBeenCalledWith({ type: "window", includeUncontrolled: true });
    expect(site.focus).toHaveBeenCalled();
    expect(site.navigate).toHaveBeenCalledWith(`${ORIGIN}/todos?id=1`);
    expect(other.focus).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("opens a window at the link when none of the site's is open", async () => {
    matchAll.mockResolvedValue([window("https://elsewhere.test/")]);
    await Promise.all(click({ link: "/todos" }).waited);
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/todos`);
  });

  it("goes to the home page when the notification has no link", async () => {
    await Promise.all(click().waited);
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });

  it.each([
    ["another site", "https://phish.test/login"],
    ["another site without a scheme", "//phish.test/login"],
    ["a script", "javascript:alert(1)"],
  ])("never follows a link to %s, though the notification still closes", (_case, link) => {
    const { close, waited } = click({ link });
    expect(close).toHaveBeenCalled();
    expect(waited).toEqual([]);
    expect(matchAll).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });
});
