import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { NotificationSettingsPage } from "@/modules/notifications";
import { renderPage } from "../render";
import { signUp } from "../users";
import { devices, fakePushService, forgetServiceWorkers, notificationPermission } from "./support";

const ON = "Push notifications are on for this browser";
const OFF = "Push notifications are off for this browser";

const open = () => renderPage(<NotificationSettingsPage />, { url: "/settings/notifications" });
const toggle = (page: Awaited<ReturnType<typeof open>>) =>
  page.getByRole("checkbox", { name: "Send push notifications to this browser" });

afterEach(async () => {
  vi.restoreAllMocks();
  await forgetServiceWorkers();
});

describe("push on this browser", () => {
  it("turns on and off, registering this browser with the API", async () => {
    notificationPermission("granted");
    const push = fakePushService();
    const user = await signUp();
    const page = await open();
    await expect.element(toggle(page)).not.toBeChecked();

    await userEvent.click(toggle(page));
    await expect.element(page.getByText(ON)).toBeVisible();
    await expect.element(toggle(page)).toBeChecked();
    expect(
      (await devices(user.id)).map(
        (device) => (JSON.parse(device.token) as { endpoint: string }).endpoint,
      ),
    ).toEqual([push.current?.endpoint]);

    await userEvent.click(toggle(page));
    await expect.element(page.getByText(OFF)).toBeVisible();
    await expect.element(toggle(page)).not.toBeChecked();
    expect(await devices(user.id)).toEqual([]);
    expect(push.current).toBeNull();
  });

  it("turns off even when the subscription is already gone", async () => {
    notificationPermission("granted");
    const push = fakePushService();
    await signUp();
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    push.existing();
    const page = await open();
    await expect.element(toggle(page)).toBeChecked();
    // The browser dropped it meanwhile (cleared site data, say).
    await push.current?.unsubscribe();
    await userEvent.click(toggle(page));
    await expect.element(page.getByText(OFF)).toBeVisible();
  });

  it("stays off when the permission prompt isn't allowed", async () => {
    notificationPermission("granted");
    fakePushService();
    await signUp();
    const page = await open();
    await expect.element(toggle(page)).not.toBeChecked();
    vi.mocked(Notification.requestPermission).mockResolvedValue("default");
    await userEvent.click(toggle(page));
    await expect.element(toggle(page)).toBeEnabled();
    await expect.element(toggle(page)).not.toBeChecked();
    expect(page.getByText(ON).query()).toBeNull();
  });

  it("says so when the subscription can't receive anything", async () => {
    notificationPermission("granted");
    const push = fakePushService();
    push.keys = false;
    const user = await signUp();
    // The service worker is already there from an earlier visit.
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    const page = await open();
    await userEvent.click(toggle(page));
    await expect
      .element(page.getByText("Something went wrong on our side. Please try again."))
      .toBeVisible();
    await expect.element(toggle(page)).not.toBeChecked();
    expect(await devices(user.id)).toEqual([]);
    // Nothing left behind that would show push as on.
    expect(push.current).toBeNull();
  });

  it("explains that the site's notifications are blocked", async () => {
    notificationPermission("denied");
    await signUp();
    const page = await open();
    await expect
      .element(page.getByText("Notifications are blocked for this site.", { exact: false }))
      .toBeVisible();
  });

  it("explains a browser without push", async () => {
    const pushManager = Object.getOwnPropertyDescriptor(window, "PushManager");
    delete (window as { PushManager?: unknown }).PushManager;
    try {
      await signUp();
      const page = await open();
      await expect
        .element(page.getByText("This browser doesn't support push notifications."))
        .toBeVisible();
    } finally {
      Object.defineProperty(window, "PushManager", pushManager as PropertyDescriptor);
    }
  });
});
