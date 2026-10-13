"use client";

import { useApiErrorMessage } from "@repo/client";
import { useDisconnectAppMutation } from "@repo/client/api/apps/disconnect";
import { useConnectedAppsQuery } from "@repo/client/api/apps/list";
import { MINUTE_MS } from "@repo/contracts/time";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Skeleton } from "@repo/ui/components/skeleton";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { toast } from "sonner";

/**
 * Apps (MCP clients) the user connected over OAuth, one row per app and workspace.
 * Disconnecting cuts the app off at once and it has to ask again.
 */
export function ConnectedAppsCard() {
  const t = useTranslations("settings.security.apps");
  const format = useFormatter();
  // An explicit, ticking "now" keeps server and client renders in agreement.
  const now = useNow({ updateInterval: MINUTE_MS });
  const errorMessage = useApiErrorMessage();
  const apps = useConnectedAppsQuery();
  const disconnect = useDisconnectAppMutation();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {apps.isPending ? <Skeleton className="h-10" /> : null}
        {!apps.isPending && !apps.data?.length ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : null}
        {apps.data?.length ? (
          <ul className="flex flex-col divide-y">
            {apps.data.map((app) => {
              const name = app.name ?? t("unnamed");
              return (
                <li key={app.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{name}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("details", {
                        workspace: app.workspace.name,
                        connected: format.dateTime(app.connectedAt, { dateStyle: "medium" }),
                      })}
                      {app.lastUsedAt
                        ? ` · ${t("lastUsed", { when: format.relativeTime(app.lastUsedAt, now) })}`
                        : null}
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disconnect.isPending}
                    aria-label={`${t("disconnect")}: ${name}`}
                    // A promise, not mutate's callbacks: those are dropped once the card
                    // unmounts, as it does when a lost session sends the user to sign in.
                    onClick={() =>
                      disconnect.mutateAsync({ id: app.id }).then(
                        () => toast.success(t("disconnected", { name })),
                        (error: unknown) => toast.error(errorMessage(error)),
                      )
                    }
                  >
                    {t("disconnect")}
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
