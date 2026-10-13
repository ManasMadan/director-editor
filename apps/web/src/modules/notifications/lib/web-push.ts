/**
 * This browser's push subscription. The service worker (public/sw.js) is registered only
 * when the user turns push on, and the subscription is sent to the API as a device.
 */
import type { PushDeviceInput } from "@repo/contracts/api";

export type BrowserPushState = "unsupported" | "blocked" | "off" | "on";

function webPushSupported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function currentSubscription() {
  if (!webPushSupported()) {
    return null;
  }
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

export async function browserPushState(): Promise<BrowserPushState> {
  if (!webPushSupported()) {
    return "unsupported";
  }
  if (Notification.permission === "denied") {
    return "blocked";
  }
  return Notification.permission === "granted" && (await currentSubscription()) ? "on" : "off";
}

/** Asks for permission and subscribes; `null` when the user doesn't allow notifications. */
export async function subscribe(publicKey: string) {
  if ((await Notification.requestPermission()) !== "granted") {
    return null;
  }
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: publicKey,
  });
}

/**
 * On sign-out: drops this browser's subscription, so the next person here starts with
 * push off. (The API already removed the device with the session.)
 */
export async function forgetBrowserPush() {
  try {
    await (await currentSubscription())?.unsubscribe();
  } catch {
    // Nothing to undo: without a session, nothing is sent to this subscription anyway.
  }
}

/** The device to register; throws for a subscription without keys (it can't be sent to). */
export function toDevice(subscription: PushSubscription): PushDeviceInput {
  const { endpoint, keys } = subscription.toJSON();
  if (!keys?.p256dh || !keys.auth) {
    throw new Error("This browser's push subscription has no encryption keys.");
  }
  return {
    platform: "web",
    subscription: {
      endpoint: endpoint ?? subscription.endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    },
  };
}
