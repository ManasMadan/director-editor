"use client";

import { useApiErrorMessage } from "@repo/client";
import { useAuditLogInfiniteQuery } from "@repo/client/api/audit/list";
import type { AuditEntry } from "@repo/contracts/api";
import { loosely } from "@repo/i18n";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Skeleton } from "@repo/ui/components/skeleton";
import { useFormatter, useTranslations } from "next-intl";

/** ICU arguments from an event payload: strings and numbers as they are, the rest as text. */
function paramsOf(payload: Record<string, unknown>) {
  const params: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "number") {
      params[key] = value;
    } else {
      params[key] = Array.isArray(value) ? value.join(", ") : String(value);
    }
  }
  return params;
}

export function WorkspaceAuditPage() {
  const t = useTranslations("workspace.audit");
  const tEvents = useTranslations("workspace.audit.events");
  const format = useFormatter();
  const log = useAuditLogInfiniteQuery();
  const errorMessage = useApiErrorMessage();
  const entries: AuditEntry[] = log.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {log.isPending ? <Skeleton className="h-32" /> : null}
        {log.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(log.error)}
          </p>
        ) : null}
        {log.isSuccess && entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : null}
        {log.isSuccess && entries.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2 font-medium">{t("what")}</th>
                <th className="py-2 font-medium">{t("who")}</th>
                <th className="py-2 text-end font-medium">{t("when")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="py-2 pe-3">
                    {loosely(tEvents).has(entry.name)
                      ? loosely(tEvents)(entry.name, paramsOf(entry.payload))
                      : entry.name}
                  </td>
                  <td className="py-2 pe-3 text-muted-foreground">
                    {entry.actor?.name ?? t("system")}
                  </td>
                  <td className="py-2 text-end whitespace-nowrap text-muted-foreground">
                    <time dateTime={entry.occurredAt.toISOString()}>
                      {format.dateTime(entry.occurredAt, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {log.hasNextPage ? (
          <Button
            variant="outline"
            className="self-start"
            onClick={() => log.fetchNextPage()}
            disabled={log.isFetchingNextPage}
          >
            {t("loadMore")}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
