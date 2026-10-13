"use client";

import { useNotificationsInfiniteQuery } from "@repo/client/api/notifications/list";
import { useMarkAllNotificationsReadMutation } from "@repo/client/api/notifications/mark-all-read";
import { useMarkNotificationsReadMutation } from "@repo/client/api/notifications/mark-read";
import { Button } from "@repo/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@repo/ui/components/card";
import { Skeleton } from "@repo/ui/components/skeleton";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { NotificationText } from "../components/notification-item";

export function NotificationsPage() {
  const t = useTranslations("notificationCenter");
  const inbox = useNotificationsInfiniteQuery();
  const markRead = useMarkNotificationsReadMutation();
  const markAllRead = useMarkAllNotificationsReadMutation();
  const items = inbox.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Card className="max-w-2xl">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>
          <h1>{t("title")}</h1>
        </CardTitle>
        {items.some((item) => !item.readAt) ? (
          <Button variant="outline" size="sm" onClick={() => markAllRead.mutate({})}>
            {t("markAllRead")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {inbox.isPending ? <Skeleton className="h-24" /> : null}
        {!inbox.isPending && items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : null}
        {items.length > 0 ? (
          <ul className="flex flex-col divide-y">
            {items.map((notification) => (
              <li key={notification.id} className="py-2">
                <Link
                  href={(notification.link ?? "/notifications") as Route}
                  onClick={() =>
                    !notification.readAt && markRead.mutate({ ids: [notification.id] })
                  }
                  className="block rounded-md p-1 hover:bg-muted"
                >
                  <NotificationText notification={notification} />
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        {inbox.hasNextPage ? (
          <Button variant="outline" className="self-start" onClick={() => inbox.fetchNextPage()}>
            {t("loadMore")}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
