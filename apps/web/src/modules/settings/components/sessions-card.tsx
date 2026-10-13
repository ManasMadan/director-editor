"use client";

import { authKeys } from "@repo/client/auth/query";
import { useSessionsQuery } from "@repo/client/auth/sessions";
import { MINUTE_MS } from "@repo/contracts/time";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Skeleton } from "@repo/ui/components/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { useAuthErrorMessage } from "@/modules/auth";
import { needsRecentSignIn, ReauthPrompt } from "./reauth-prompt";

// In the order to test them: Edge's user agent also says Chrome, Chrome's says Safari,
// and Android's says Linux.
const BROWSERS: [RegExp, string][] = [
  [/Edg\//, "Edge"],
  [/Chrome\//, "Chrome"],
  [/Firefox\//, "Firefox"],
  [/Safari\//, "Safari"],
];
const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad/, "iOS"],
  [/Android/, "Android"],
  [/Mac OS X/, "macOS"],
  [/Windows/, "Windows"],
  [/Linux/, "Linux"],
];

/** A readable device name from a user agent, without a parsing library. */
function deviceName(userAgent: string | null | undefined) {
  if (!userAgent) {
    return null;
  }
  const first = (names: [RegExp, string][]) =>
    names.find(([pattern]) => pattern.test(userAgent))?.[1];
  const browser = first(BROWSERS) ?? "Browser";
  const os = first(SYSTEMS);
  return os ? `${browser} · ${os}` : browser;
}

export function SessionsCard() {
  const t = useTranslations("settings.security.sessions");
  const format = useFormatter();
  // An explicit, ticking "now" keeps server and client renders in agreement.
  const now = useNow({ updateInterval: MINUTE_MS });
  const errorMessage = useAuthErrorMessage();
  const queryClient = useQueryClient();
  const { data: current } = authClient.useSession();
  const sessions = useSessionsQuery(authClient);

  async function run(action: () => Promise<{ error: { code?: string | undefined } | null }>) {
    const { error } = await action();
    if (error) {
      toast.error(errorMessage(error));
    } else {
      toast.success(t("revoked"));
    }
    await queryClient.invalidateQueries({ queryKey: authKeys.sessions() });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {sessions.isPending ? <Skeleton className="h-16" /> : null}
        {sessions.isError && needsRecentSignIn(sessions.error) ? <ReauthPrompt /> : null}
        {sessions.isError && !needsRecentSignIn(sessions.error) ? (
          <p className="text-sm text-destructive">{errorMessage(sessions.error)}</p>
        ) : null}
        {sessions.isSuccess ? (
          <ul className="flex flex-col divide-y">
            {sessions.data?.map((session) => {
              const isCurrent = session.id === current?.session.id;
              return (
                <li key={session.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="flex flex-col">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {deviceName(session.userAgent) ?? t("unknownDevice")}
                      {isCurrent ? <Badge variant="secondary">{t("current")}</Badge> : null}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t("lastActive", {
                        date: format.relativeTime(new Date(session.updatedAt), now),
                      })}
                      {session.ipAddress ? ` · ${session.ipAddress}` : ""}
                    </span>
                  </div>
                  {isCurrent ? null : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => run(() => authClient.revokeSession({ token: session.token }))}
                    >
                      {t("revoke")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
        {(sessions.data?.length ?? 0) > 1 ? (
          <Button
            variant="outline"
            className="self-start"
            onClick={() => run(() => authClient.revokeOtherSessions())}
          >
            {t("revokeOthers")}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
