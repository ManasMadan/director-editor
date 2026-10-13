/**
 * Browser push. Headless Chromium can't reach a real push service, so the subscription
 * itself is stubbed (a PushManager that hands out an FCM-looking endpoint and remembers
 * it across reloads); everything else is real: permission, the service worker, the API
 * registering the device, and the service worker showing a pushed message.
 */
import type { BrowserContext, Page } from "@playwright/test";
import { expect, signIn, signOut, signUp, test } from "./support";

/** Replaces PushManager's subscription with a stub; `permission` fakes the user's answer. */
async function stubPush(context: BrowserContext, permission: "granted" | "denied" = "granted") {
  if (permission === "granted") {
    await context.grantPermissions(["notifications"]);
  }
  await context.addInitScript((answer) => {
    const KEY = "e2e-push-subscription";
    // Headless Chromium reports Notification.permission as "denied" even when granted
    // (the Permissions API says "granted"); real browsers agree, so mirror the answer.
    Object.defineProperty(Notification, "permission", { get: () => answer });
    Notification.requestPermission = async () => answer;
    const fake = (endpoint: string) => ({
      endpoint,
      expirationTime: null,
      toJSON: () => ({
        endpoint,
        keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4Y", auth: "tBHItJI5svbpez7KI4CCXg" },
      }),
      unsubscribe: async () => {
        localStorage.removeItem(KEY);
        localStorage.setItem("e2e-push-unsubscribed", "yes");
        return true;
      },
      getKey: () => null,
      options: {},
    });
    PushManager.prototype.getSubscription = async () => {
      const endpoint = localStorage.getItem(KEY);
      return (endpoint ? fake(endpoint) : null) as unknown as PushSubscription;
    };
    PushManager.prototype.subscribe = async () => {
      const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${crypto.randomUUID()}`;
      localStorage.setItem(KEY, endpoint);
      return fake(endpoint) as unknown as PushSubscription;
    };
  }, permission);
}

const registered = (page: Page) =>
  page.waitForResponse(
    (response) => response.url().includes("/notifications/registerDevice") && response.ok(),
  );

async function openSettings(page: Page) {
  await page.goto("/settings/notifications");
  return page.getByRole("checkbox", { name: "Send push notifications to this browser" });
}

test("turning push on registers this browser; turning it off removes it", async ({
  page,
  context,
}) => {
  await stubPush(context);
  await signUp(page);
  const toggle = await openSettings(page);
  await expect(toggle).not.toBeChecked();

  const registration = registered(page);
  await toggle.click();
  await registration;
  await expect(page.getByText("Push notifications are on for this browser")).toBeVisible();
  await expect(toggle).toBeChecked();
  // The service worker is installed and in control of the site.
  expect(
    await page.evaluate(
      async () => (await navigator.serviceWorker.getRegistration("/"))?.active?.scriptURL,
    ),
  ).toMatch(/\/sw\.js$/);

  // Still on after a reload, and the page load re-registers it (a rotated subscription,
  // or another account signed in on this browser, gets picked up this way).
  const again = registered(page);
  await page.reload();
  await again;
  await expect(toggle).toBeChecked();

  const removal = page.waitForResponse(
    (response) => response.url().includes("/notifications/unregisterDevice") && response.ok(),
  );
  await toggle.click();
  await removal;
  await expect(page.getByText("Push notifications are off for this browser")).toBeVisible();
  await expect(toggle).not.toBeChecked();
});

test("a blocked site explains how to allow notifications instead of a toggle", async ({
  page,
  context,
}) => {
  await stubPush(context, "denied");
  await signUp(page);
  await page.goto("/settings/notifications");
  await expect(page.getByText(/Notifications are blocked for this site/)).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Send push notifications to this browser" }),
  ).toHaveCount(0);
});

test("dismissing the permission prompt leaves push off, without an error", async ({
  page,
  context,
}) => {
  // The user closes the prompt without answering: permission stays "default".
  await context.addInitScript(() => {
    Object.defineProperty(Notification, "permission", { get: () => "default" });
    Notification.requestPermission = async () => "default";
  });
  await signUp(page);
  const toggle = await openSettings(page);
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
});

test("signing out drops this browser's subscription for the next person", async ({
  page,
  context,
}) => {
  await stubPush(context);
  const user = await signUp(page);
  const toggle = await openSettings(page);
  const registration = registered(page);
  await toggle.click();
  await registration;

  await signOut(page, user);
  expect(await page.evaluate(() => localStorage.getItem("e2e-push-unsubscribed"))).toBe("yes");
  await signIn(page, user);
  await expect(await openSettings(page)).not.toBeChecked();
});

test("the service worker shows a pushed message, and ignores malformed ones", async ({
  page,
  context,
}) => {
  await stubPush(context);
  await signUp(page);
  const toggle = await openSettings(page);
  const registration = registered(page);
  await toggle.click();
  await registration;

  // Headless Chromium can't display notifications, so record what the worker asks for.
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await worker.evaluate(() => {
    const shown: unknown[] = [];
    (self as unknown as { shown: unknown[] }).shown = shown;
    ServiceWorkerRegistration.prototype.showNotification = async (title, options) => {
      shown.push({ title, ...options });
    };
  });

  const cdp = await context.newCDPSession(page);
  const registrationId = new Promise<string>((resolve) => {
    cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
      const ours = registrations.find((r) => r.scopeURL.endsWith("/") && !r.isDeleted);
      if (ours) {
        resolve(ours.registrationId);
      }
    });
  });
  await cdp.send("ServiceWorker.enable");
  const deliver = async (data: string) =>
    cdp.send("ServiceWorker.deliverPushMessage", {
      origin: new URL(page.url()).origin,
      registrationId: await registrationId,
      data,
    });
  await deliver("not json");
  await deliver(JSON.stringify({ body: "no title" }));
  await deliver(
    JSON.stringify({
      title: "Reminder",
      body: "Water the plants",
      link: "/dashboard",
      tag: "todo.reminder",
    }),
  );
  await expect
    .poll(() => worker.evaluate(() => (self as unknown as { shown: unknown[] }).shown))
    .toEqual([
      {
        title: "Reminder",
        body: "Water the plants",
        tag: "todo.reminder",
        data: { link: "/dashboard" },
      },
    ]);
});

test("the service worker is served with the page's security headers", async ({ page }) => {
  const response = await page.request.get("/sw.js");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toMatch(/javascript/);
  const home = await page.goto("/");
  expect(home?.headers()["content-security-policy"]).toContain("worker-src 'self'");
});
