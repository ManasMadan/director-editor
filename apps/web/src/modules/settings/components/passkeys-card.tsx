"use client";

import { usePasskeysQuery } from "@repo/client/auth/passkeys";
import { authKeys } from "@repo/client/auth/query";
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
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { useAuthErrorMessage } from "@/modules/auth";
import { needsRecentSignIn, ReauthPrompt } from "./reauth-prompt";

export function PasskeysCard() {
  const t = useTranslations("settings.security.passkeys");
  const format = useFormatter();
  const errorMessage = useAuthErrorMessage();
  const queryClient = useQueryClient();
  const passkeys = usePasskeysQuery(authClient);
  const [staleSession, setStaleSession] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: authKeys.passkeys() });

  async function add() {
    const result = await authClient.passkey.addPasskey();
    if (result?.error) {
      if (needsRecentSignIn(result.error)) {
        setStaleSession(true);
      } else {
        toast.error(errorMessage(result.error));
      }
      return;
    }
    // The list is up to date by the time the confirmation shows.
    await refresh();
    toast.success(t("added"));
  }

  async function remove(id: string) {
    const { error } = await authClient.passkey.deletePasskey({ id });
    if (error) {
      toast.error(errorMessage(error));
    }
    await refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {staleSession ? <ReauthPrompt /> : null}
        {passkeys.isPending ? <Skeleton className="h-10" /> : null}
        {!passkeys.isPending && !passkeys.data?.length ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : null}
        {passkeys.data?.length ? (
          <ul className="flex flex-col divide-y">
            {passkeys.data.map((passkey) => (
              <li key={passkey.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span>
                  {passkey.name ?? t("unnamed")}
                  {passkey.createdAt ? (
                    <span className="ms-2 text-muted-foreground">
                      {format.dateTime(new Date(passkey.createdAt), { dateStyle: "medium" })}
                    </span>
                  ) : null}
                </span>
                <Button variant="outline" size="sm" onClick={() => remove(passkey.id)}>
                  {t("remove")}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <Button variant="outline" className="self-start" onClick={add}>
          {t("add")}
        </Button>
      </CardContent>
    </Card>
  );
}
