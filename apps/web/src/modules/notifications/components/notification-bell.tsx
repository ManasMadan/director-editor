"use client";

import { useNotificationsInfiniteQuery } from "@repo/client/api/notifications/list";
import { useMarkAllNotificationsReadMutation } from "@repo/client/api/notifications/mark-all-read";
import { useMarkNotificationsReadMutation } from "@repo/client/api/notifications/mark-read";
import { useUnreadNotificationsCountQuery } from "@repo/client/api/notifications/unread-count";
import { Button } from "@repo/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import { Bell } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { NotificationText } from "./notification-item";

const RECENT = 5;

/** Header bell: unread count, the latest few, and a way to the full inbox. */
export function NotificationBell() {
  const t = useTranslations("notificationCenter");
  const router = useRouter();
  const unread = useUnreadNotificationsCountQuery();
  const inbox = useNotificationsInfiniteQuery(RECENT);
  const markRead = useMarkNotificationsReadMutation();
  const markAllRead = useMarkAllNotificationsReadMutation();
  const count = unread.data?.count ?? 0;
  const recent = inbox.data?.pages[0]?.items ?? [];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="relative"
            aria-label={count > 0 ? t("unread", { count }) : t("open")}
          />
        }
      >
        <Bell />
        {count > 0 ? (
          <span
            aria-hidden
            className="absolute end-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-white"
          >
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("title")}</DropdownMenuLabel>
          {recent.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            recent.map((notification) => (
              <DropdownMenuItem
                key={notification.id}
                onClick={() => {
                  if (!notification.readAt) {
                    markRead.mutate({ ids: [notification.id] });
                  }
                  if (notification.link) {
                    router.push(notification.link as Route);
                  }
                }}
              >
                <NotificationText notification={notification} />
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {count > 0 ? (
          <DropdownMenuItem onClick={() => markAllRead.mutate({})}>
            {t("markAllRead")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={() => router.push("/notifications")}>
          {t("viewAll")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
