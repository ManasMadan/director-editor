"use client";

import { useRegisterDeviceMutation } from "@repo/client/api/notifications/register-device";
import { useEffect } from "react";
import { authClient } from "@/lib/auth-client";
import { currentSubscription, toDevice } from "../lib/web-push";

/**
 * Re-registers this browser's push subscription once per signed-in page load: it keeps
 * the device current when the browser rotates the subscription, and moves it to whoever
 * is signed in now. Renders nothing.
 */
export function PushSync() {
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;
  const { mutate } = useRegisterDeviceMutation();

  useEffect(() => {
    if (!userId || typeof Notification === "undefined" || Notification.permission !== "granted") {
      return;
    }
    let cancelled = false;
    void currentSubscription()
      .then((subscription) => {
        if (subscription && !cancelled) {
          mutate({ device: toDevice(subscription) });
        }
      })
      // A subscription without keys stays unregistered: turning push on in settings shows
      // the error (toDevice throws it there too).
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [userId, mutate]);
  return null;
}
