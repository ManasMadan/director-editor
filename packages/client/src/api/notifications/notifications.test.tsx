import type { AppNotification, NotificationPreferences } from "@repo/contracts/api";
import { notificationIdSchema } from "@repo/contracts/ids";
import { toPage } from "@repo/contracts/pagination";
import { describe, expect, it, vi } from "vitest";
import { id, renderHook, standIn } from "../../../test/stand-in";
import { useNotificationsInfiniteQuery } from "./list";
import { useMarkAllNotificationsReadMutation } from "./mark-all-read";
import { useMarkNotificationsReadMutation } from "./mark-read";
import { useNotificationPreferencesQuery } from "./preferences";
import { useRegisterDeviceMutation } from "./register-device";
import { useUnreadNotificationsCountQuery } from "./unread-count";
import { useUnregisterDeviceMutation } from "./unregister-device";
import { useUnsubscribeMutation } from "./unsubscribe";
import { useUpdateNotificationPreferencesMutation } from "./update-preferences";

const notification = (n: number): AppNotification => ({
  id: notificationIdSchema.parse(id(n)),
  type: "todo.reminder",
  data: { todoId: id(100 + n), title: `Todo ${n}` },
  link: null,
  readAt: null,
  createdAt: new Date(n),
});

describe("the inbox", () => {
  it("pages through notifications, and marking them read updates the list and the count", async () => {
    const inbox = [notification(3), notification(2), notification(1)];
    const unread = () => inbox.filter((n) => n.readAt === null).length;
    const api = standIn((os) => ({
      notifications: {
        list: os.notifications.list.handler(({ input }) => {
          const start = input.cursor ? inbox.findIndex((n) => n.id === input.cursor) + 1 : 0;
          return toPage(inbox.slice(start), input.limit);
        }),
        unreadCount: os.notifications.unreadCount.handler(() => ({ count: unread() })),
        markRead: os.notifications.markRead.handler(({ input }) => {
          for (const n of inbox) {
            if (input.ids.includes(n.id)) {
              n.readAt = new Date();
            }
          }
        }),
        markAllRead: os.notifications.markAllRead.handler(() => {
          for (const n of inbox) {
            n.readAt = new Date();
          }
        }),
      },
    }));
    const { result } = renderHook(
      () => ({
        list: useNotificationsInfiniteQuery(2),
        count: useUnreadNotificationsCountQuery(),
        markRead: useMarkNotificationsReadMutation(),
        markAllRead: useMarkAllNotificationsReadMutation(),
      }),
      api,
    );
    const read = () =>
      result.current.list.data?.pages.flatMap((p) => p.items.map((n) => n.readAt !== null));
    await vi.waitFor(() => expect(read()).toEqual([false, false]));
    await result.current.list.fetchNextPage();
    await vi.waitFor(() => expect(read()).toEqual([false, false, false]));
    expect(result.current.list.hasNextPage).toBe(false);
    expect(result.current.count.data).toEqual({ count: 3 });

    await result.current.markRead.mutateAsync({ ids: [id(3)] });
    await vi.waitFor(() => expect(read()).toEqual([true, false, false]));
    await vi.waitFor(() => expect(result.current.count.data).toEqual({ count: 2 }));

    await result.current.markAllRead.mutateAsync();
    await vi.waitFor(() => expect(result.current.count.data).toEqual({ count: 0 }));
    expect(read()).toEqual([true, true, true]);
  });
});

describe("notification preferences", () => {
  it("shows the saved preferences and replaces them with what the change returns", async () => {
    let preferences: NotificationPreferences = {
      categories: [{ name: "activity", channels: [{ channel: "email", enabled: true }] }],
      dailyDigest: false,
      quietHours: null,
    };
    const api = standIn((os) => ({
      notifications: {
        preferences: os.notifications.preferences.handler(() => preferences),
        updatePreferences: os.notifications.updatePreferences.handler(({ input }) => {
          preferences = {
            ...preferences,
            dailyDigest: input.dailyDigest ?? preferences.dailyDigest,
          };
          return preferences;
        }),
        unsubscribe: os.notifications.unsubscribe.handler(() => ({ category: "activity" })),
      },
    }));
    const { result } = renderHook(
      () => ({
        preferences: useNotificationPreferencesQuery(),
        update: useUpdateNotificationPreferencesMutation(),
        unsubscribe: useUnsubscribeMutation(),
      }),
      api,
    );
    await vi.waitFor(() => expect(result.current.preferences.data?.dailyDigest).toBe(false));
    await result.current.update.mutateAsync({ dailyDigest: true });
    await vi.waitFor(() => expect(result.current.preferences.data?.dailyDigest).toBe(true));
    expect(api.calls.filter((call) => call === "notifications/preferences")).toHaveLength(1);

    await expect(
      result.current.unsubscribe.mutateAsync({ token: "t".repeat(20) }),
    ).resolves.toEqual({ category: "activity" });
  });
});

describe("push devices", () => {
  it("registers a device and removes it", async () => {
    const devices = new Set<string>();
    const api = standIn((os) => ({
      notifications: {
        registerDevice: os.notifications.registerDevice.handler(({ input }) => {
          devices.add(JSON.stringify(input.device));
          return { id: id(1) };
        }),
        unregisterDevice: os.notifications.unregisterDevice.handler(({ input }) => {
          devices.delete(JSON.stringify(input.device));
        }),
      },
    }));
    const { result } = renderHook(
      () => ({ register: useRegisterDeviceMutation(), unregister: useUnregisterDeviceMutation() }),
      api,
    );
    const device = { platform: "ios" as const, token: "a".repeat(64) };
    await expect(result.current.register.mutateAsync({ device })).resolves.toEqual({ id: id(1) });
    expect(devices.size).toBe(1);
    await result.current.unregister.mutateAsync({ device });
    expect(devices.size).toBe(0);
  });
});
