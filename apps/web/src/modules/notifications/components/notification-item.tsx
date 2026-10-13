"use client";

import type { AppNotification } from "@repo/contracts/api";
import { MINUTE_MS } from "@repo/contracts/time";
import { loosely } from "@repo/i18n";
import { cn } from "@repo/ui/lib/utils";
import { useFormatter, useNow, useTranslations } from "next-intl";

/** One notification's text, rendered from its type's copy in the reader's language. */
export function NotificationText({ notification }: { notification: AppNotification }) {
  const t = useTranslations("notification");
  const format = useFormatter();
  const now = useNow({ updateInterval: MINUTE_MS });
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className={cn("text-sm", !notification.readAt && "font-medium")}>
        {loosely(t)(`${notification.type}.title`, notification.data)}
      </span>
      <span className="text-xs text-muted-foreground">
        {loosely(t)(`${notification.type}.body`, notification.data)}
      </span>
      <time
        className="text-xs text-muted-foreground"
        dateTime={notification.createdAt.toISOString()}
      >
        {format.relativeTime(notification.createdAt, now)}
      </time>
    </div>
  );
}
