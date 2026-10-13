"use client";

import { useApiErrorMessage } from "@repo/client";
import { useRegisterDeviceMutation } from "@repo/client/api/notifications/register-device";
import { useUnregisterDeviceMutation } from "@repo/client/api/notifications/unregister-device";
import { useSystemInfoQuery } from "@repo/client/api/system/info";
import { Alert, AlertDescription } from "@repo/ui/components/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Checkbox } from "@repo/ui/components/checkbox";
import { Field, FieldLabel } from "@repo/ui/components/field";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  type BrowserPushState,
  browserPushState,
  currentSubscription,
  subscribe,
  toDevice,
} from "../lib/web-push";

/** Turns push on or off for this browser. Hidden when the API has browser push off. */
export function BrowserPushCard() {
  const t = useTranslations("notificationSettings.browserPush");
  const errorMessage = useApiErrorMessage();
  const { data: system } = useSystemInfoQuery();
  const register = useRegisterDeviceMutation();
  const unregister = useUnregisterDeviceMutation();
  const [state, setState] = useState<BrowserPushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void browserPushState().then(setState);
  }, []);

  const publicKey = system?.webPushPublicKey;
  if (!publicKey || state === null) {
    return null;
  }

  async function toggle(on: boolean) {
    setBusy(true);
    try {
      if (on && publicKey) {
        const subscription = await subscribe(publicKey);
        if (!subscription) {
          setState(await browserPushState());
          return;
        }
        try {
          await register.mutateAsync({ device: toDevice(subscription) });
        } catch (error) {
          // A subscription the API doesn't know would show push as on, with nothing sent.
          await subscription.unsubscribe();
          throw error;
        }
        toast.success(t("enabled"));
      } else {
        const subscription = await currentSubscription();
        if (subscription) {
          await unregister.mutateAsync({ device: toDevice(subscription) });
          await subscription.unsubscribe();
        }
        toast.success(t("disabled"));
      }
      setState(await browserPushState());
    } catch (error) {
      toast.error(errorMessage(error));
      setState(await browserPushState());
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {state === "unsupported" ? (
          <p className="text-sm text-muted-foreground">{t("unsupported")}</p>
        ) : null}
        {state === "blocked" ? (
          <Alert>
            <AlertDescription>{t("blocked")}</AlertDescription>
          </Alert>
        ) : null}
        {state !== "unsupported" && state !== "blocked" ? (
          <Field orientation="horizontal">
            <Checkbox
              id="browser-push"
              checked={state === "on"}
              disabled={busy}
              onCheckedChange={(checked) => void toggle(checked === true)}
            />
            <FieldLabel htmlFor="browser-push" className="font-normal">
              {t("enable")}
            </FieldLabel>
          </Field>
        ) : null}
      </CardContent>
    </Card>
  );
}
