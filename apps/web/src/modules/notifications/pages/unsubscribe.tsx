"use client";

import { useApiErrorMessage } from "@repo/client";
import { useUnsubscribeMutation } from "@repo/client/api/notifications/unsubscribe";
import { Button, buttonVariants } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

/** Where an email's "Unsubscribe" link lands. Works signed out; the token says who. */
export function UnsubscribePage() {
  const t = useTranslations("unsubscribe");
  const tCategories = useTranslations("notificationSettings.categories");
  const errorMessage = useApiErrorMessage();
  const token = useSearchParams().get("token");
  const unsubscribe = useUnsubscribeMutation();

  return (
    <div className="mx-auto mt-8 w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>
            <h1>{t("title")}</h1>
          </CardTitle>
          {unsubscribe.data ? (
            <CardDescription role="status">
              {t("done", { category: tCategories(`${unsubscribe.data.category}.title`) })}
            </CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3">
          {token ? null : <p className="text-sm text-muted-foreground">{t("missing")}</p>}
          {token && !unsubscribe.data ? (
            <>
              <Button
                onClick={() => unsubscribe.mutate({ token })}
                disabled={unsubscribe.isPending}
              >
                {t("title")}
              </Button>
              {unsubscribe.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {errorMessage(unsubscribe.error)}
                </p>
              ) : null}
            </>
          ) : null}
          <Link href="/settings/notifications" className={buttonVariants({ variant: "link" })}>
            {t("manage")}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
