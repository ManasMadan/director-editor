import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetBrowserPush, PushSync } from "@/modules/notifications";
import { cleanup, renderPage } from "../render";
import { signUp } from "../users";
import { devices, fakePushService, forgetServiceWorkers, notificationPermission } from "./support";

afterEach(async () => {
  vi.restoreAllMocks();
  await forgetServiceWorkers();
});

/** A browser that turned push on during an earlier visit. */
async function subscribedBefore(options: { keys?: boolean } = {}) {
  notificationPermission("granted");
  const push = fakePushService();
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  push.existing(options);
  return push;
}

describe("keeping this browser's push registration current", () => {
  it("registers the existing subscription for whoever is signed in", async () => {
    const push = await subscribedBefore();
    const user = await signUp();
    await renderPage(<PushSync />, { url: "/dashboard" });
    await expect
      .poll(async () =>
        (await devices(user.id)).map((d) => (JSON.parse(d.token) as { endpoint: string }).endpoint),
      )
      .toEqual([push.current?.endpoint]);
  });

  it("registers nothing when the page is left first, or without a subscription", async () => {
    const push = await subscribedBefore();
    const subscription = push.current;
    const user = await signUp();
    const getSubscription = vi.mocked(PushManager.prototype.getSubscription);
    let answer: (found: PushSubscription | null) => void = () => undefined;
    getSubscription.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await renderPage(<PushSync />, { url: "/dashboard" });
    await expect.poll(() => getSubscription.mock.calls.length).toBe(1);
    // The page is gone before the browser answers.
    cleanup();
    answer(subscription);

    getSubscription.mockResolvedValue(null);
    await renderPage(<PushSync />, { url: "/dashboard" });
    await expect.poll(() => getSubscription.mock.calls.length).toBe(2);
    expect(await devices(user.id)).toEqual([]);
  });

  it("leaves a subscription without keys unregistered", async () => {
    await subscribedBefore({ keys: false });
    const user = await signUp();
    await renderPage(<PushSync />, { url: "/dashboard" });
    await expect
      .poll(() => vi.mocked(PushManager.prototype.getSubscription).mock.calls.length)
      .toBe(1);
    expect(await devices(user.id)).toEqual([]);
  });

  it("does nothing without the permission, or without notifications at all", async () => {
    notificationPermission("default");
    const push = fakePushService();
    await signUp();
    await renderPage(<PushSync />, { url: "/dashboard" });
    cleanup();
    const notification = Object.getOwnPropertyDescriptor(window, "Notification");
    delete (window as { Notification?: unknown }).Notification;
    try {
      await renderPage(<PushSync />, { url: "/dashboard" });
    } finally {
      cleanup();
      Object.defineProperty(window, "Notification", notification as PropertyDescriptor);
    }
    expect(vi.mocked(PushManager.prototype.getSubscription)).not.toHaveBeenCalled();
    expect(push.current).toBeNull();
  });
});

describe("forgetting push on sign-out", () => {
  it("drops this browser's subscription", async () => {
    const push = await subscribedBefore();
    await forgetBrowserPush();
    expect(push.current).toBeNull();
    // Nothing left to drop.
    await forgetBrowserPush();
  });

  it("gives up quietly when the browser can't say", async () => {
    vi.spyOn(navigator.serviceWorker, "getRegistration").mockRejectedValue(new Error("gone"));
    await expect(forgetBrowserPush()).resolves.toBeUndefined();
  });
});
