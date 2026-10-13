/**
 * The push service worker (public/sw.js), loaded into a stand-in for its global scope: what
 * it shows for a push, and where a click on the notification goes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: object) => void;

const worker = vi.hoisted(() => {
  const listeners = new Map<string, (event: object) => void>();
  const scope = {
    addEventListener: (type: string, listener: (event: object) => void) => {
      listeners.set(type, listener);
    },
    registration: {
      showNotification: vi.fn(async (_title: string, _options: object) => undefined),
    },
    location: { origin: "https://app.test" },
    clients: {
      matchAll: vi.fn(async (_options: object): Promise<object[]> => []),
      openWindow: vi.fn(async (_url: string) => null),
    },
  };
  Object.assign(globalThis, { self: scope });
  return { listeners, scope };
});

import "../../../../public/sw.js";

/** Dispatches an event the way the browser does, and waits for what it asked to wait for. */
async function dispatch(type: string, event: object) {
  const waits: Promise<unknown>[] = [];
  const listener = worker.listeners.get(type) as Listener;
  listener({ ...event, waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
  await Promise.all(waits);
  return waits.length;
}

beforeEach(() => vi.clearAllMocks());

describe("a push", () => {
  const push = (payload: unknown) => ({ data: { json: () => payload } });

  it("shows the notification apps/notifications sent", async () => {
    await dispatch("push", push({ title: "Invited", body: "To Acme", tag: "invite", link: "/x" }));
    expect(worker.scope.registration.showNotification).toHaveBeenCalledWith("Invited", {
      body: "To Acme",
      tag: "invite",
      data: { link: "/x" },
    });
  });

  it("leaves out what isn't text, and opens the home page by default", async () => {
    await dispatch("push", push({ title: "Hello", body: 1, tag: null, link: {} }));
    expect(worker.scope.registration.showNotification).toHaveBeenCalledWith("Hello", {
      body: undefined,
      tag: undefined,
      data: { link: "/" },
    });
  });

  it("shows nothing without a title, a payload, or readable JSON", async () => {
    expect(await dispatch("push", push({ body: "no title" }))).toBe(0);
    expect(await dispatch("push", { data: null })).toBe(0);
    const broken = {
      data: {
        json: () => {
          throw new SyntaxError("not JSON");
        },
      },
    };
    expect(await dispatch("push", broken)).toBe(0);
    expect(worker.scope.registration.showNotification).not.toHaveBeenCalled();
  });
});

describe("a click on the notification", () => {
  const click = (data?: object) => ({ notification: { close: vi.fn(), data } });

  it("focuses an open window of the site and takes it to the link", async () => {
    const open = {
      url: "https://app.test/home",
      focus: vi.fn(async () => undefined),
      navigate: vi.fn(),
    };
    worker.scope.clients.matchAll.mockResolvedValueOnce([{ url: "https://other.test/" }, open]);
    const event = click({ link: "/invitations/1" });
    await dispatch("notificationclick", event);
    expect(event.notification.close).toHaveBeenCalled();
    expect(open.focus).toHaveBeenCalled();
    expect(open.navigate).toHaveBeenCalledWith("https://app.test/invitations/1");
  });

  it("opens a window when none is open, at the home page without a link", async () => {
    await dispatch("notificationclick", click());
    expect(worker.scope.clients.openWindow).toHaveBeenCalledWith("https://app.test/");
  });

  it("never opens another site", async () => {
    expect(await dispatch("notificationclick", click({ link: "https://evil.test/" }))).toBe(0);
    expect(worker.scope.clients.openWindow).not.toHaveBeenCalled();
  });
});
