import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { devicePushToken, presentForegroundNotifications, pushState } from "./push";

// Whether the app runs on a real device (false on simulators), read at call time.
let mockIsDevice = true;
jest.mock("expo-device", () => ({
  get isDevice() {
    return mockIsDevice;
  },
}));
jest.mock("expo-notifications", () => ({
  AndroidImportance: { DEFAULT: 3 },
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getDevicePushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
}));

const notifications = jest.mocked(Notifications);
const permission = (status: string) => ({ status }) as never;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsDevice = true;
  jest.replaceProperty(Platform, "OS", "ios");
  notifications.getPermissionsAsync.mockResolvedValue(permission("undetermined"));
});

describe("push notifications", () => {
  it("are unavailable on a simulator", async () => {
    mockIsDevice = false;
    expect(await pushState()).toBe("unavailable");
    expect(await devicePushToken()).toBeNull();
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it("report the permission the user gave", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(permission("denied"));
    expect(await pushState()).toBe("denied");
  });

  it("give no token when the user declines", async () => {
    notifications.requestPermissionsAsync.mockResolvedValue(permission("denied"));
    expect(await devicePushToken()).toBeNull();
    expect(notifications.getDevicePushTokenAsync).not.toHaveBeenCalled();
  });

  it("give the native APNs token on iOS", async () => {
    notifications.requestPermissionsAsync.mockResolvedValue(permission("granted"));
    notifications.getDevicePushTokenAsync.mockResolvedValue({ type: "ios", data: "ab12" });
    expect(await devicePushToken()).toEqual({ platform: "ios", token: "ab12" });
    expect(notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
  });

  it("set up the default channel, then give the FCM token on Android", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    notifications.requestPermissionsAsync.mockResolvedValue(permission("granted"));
    notifications.getDevicePushTokenAsync.mockResolvedValue({ type: "android", data: "fcm-1" });
    expect(await devicePushToken()).toEqual({ platform: "android", token: "fcm-1" });
    expect(notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ importance: 3 }),
    );
  });
});

describe("a notification that arrives while the app is open", () => {
  it("shows, sounds and badges as the system would", async () => {
    presentForegroundNotifications();
    const handler = notifications.setNotificationHandler.mock.calls[0]?.[0];
    expect(await handler?.handleNotification({} as never)).toEqual({
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    });
  });
});
