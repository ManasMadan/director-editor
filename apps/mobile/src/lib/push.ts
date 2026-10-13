/**
 * Push notifications on this device. The notification service sends straight to APNs
 * (iOS) and FCM (Android), so the app registers the device's native token (not an Expo
 * push token) with the API. The registration belongs to the session: signing out stops
 * pushes to this device.
 */
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

export type PushState = "unavailable" | "denied" | "undetermined" | "granted";

/** Show notifications that arrive while the app is open, like the system would. */
export function presentForegroundNotifications() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

export async function pushState(): Promise<PushState> {
  if (!Device.isDevice || Platform.OS === "web") {
    return "unavailable";
  }
  const { status } = await Notifications.getPermissionsAsync();
  return status as PushState;
}

/** Asks for permission (if needed) and returns the device's APNs/FCM token, or null. */
export async function devicePushToken(): Promise<{
  platform: "ios" | "android";
  token: string;
} | null> {
  if ((await pushState()) === "unavailable") {
    return null;
  }
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Default",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== "granted") {
    return null;
  }
  const { data }: { data: unknown } = await Notifications.getDevicePushTokenAsync();
  return { platform: Platform.OS === "ios" ? "ios" : "android", token: String(data) };
}
