"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { FieldGroup } from "@repo/ui/components/field";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import QRCode from "react-qr-code";
import { toast } from "sonner";
import * as z from "zod";
import { OtpField } from "@/components/form-fields";
import { authClient } from "@/lib/auth-client";
import { useAuthErrorMessage, useAuthSchemas } from "@/modules/auth";
import { PasswordConfirm } from "./password-confirm";

type Setup = { totpURI: string; backupCodes: string[] };

/**
 * Turning on two-step verification is two steps: the password returns a secret (shown as
 * a QR code) and backup codes, then a code from the app proves it was scanned. Until
 * that code is verified, sign-in doesn't ask for one.
 */
export function TwoFactorCard() {
  const t = useTranslations("settings.security.twoFactor");
  const errorMessage = useAuthErrorMessage();
  const { data: session, refetch } = authClient.useSession();
  const [setup, setSetup] = useState<Setup | null>(null);
  const enabled = session?.user.twoFactorEnabled === true;

  async function disable(password: string) {
    const { error } = await authClient.twoFactor.disable({ password });
    if (error) {
      return errorMessage(error);
    }
    await refetch();
    return undefined;
  }

  async function enable(password: string) {
    // The authenticator (TOTP) method, which needs a scan-and-confirm step: its answer is
    // always the secret and backup codes.
    const { data, error } = await authClient.twoFactor.enable({ password, method: "totp" });
    if (error) {
      return errorMessage(error);
    }
    setSetup(data as Setup);
    return undefined;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t("title")}
          {enabled ? <Badge variant="secondary">{t("enabled")}</Badge> : null}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {setup ? (
          <ConfirmSetup
            setup={setup}
            onDone={async () => {
              setSetup(null);
              await refetch();
            }}
          />
        ) : (
          <PasswordConfirm
            label={t("confirmPassword")}
            submit={enabled ? t("disable") : t("enable")}
            variant={enabled ? "destructive" : "default"}
            onConfirm={enabled ? disable : enable}
          />
        )}
      </CardContent>
    </Card>
  );
}

function ConfirmSetup({ setup, onDone }: { setup: Setup; onDone: () => Promise<void> }) {
  const t = useTranslations("settings.security.twoFactor");
  const tAuth = useTranslations("auth");
  const errorMessage = useAuthErrorMessage();
  const schema = z.object({ code: useAuthSchemas().otp });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { code: "" } });

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm">{t("scan")}</p>
      {/* White background regardless of theme: scanners need dark-on-light. */}
      <div className="self-start rounded-lg bg-white p-3">
        <QRCode value={setup.totpURI} size={160} aria-label={t("title")} />
      </div>
      <div className="text-sm">
        <p className="text-muted-foreground">{t("manualKey")}</p>
        <code className="font-mono break-all" data-testid="totp-secret">
          {new URL(setup.totpURI).searchParams.get("secret")}
        </code>
      </div>
      <div>
        <h3 className="text-sm font-medium">{t("backupCodes")}</h3>
        <p className="text-sm text-muted-foreground">{t("backupCodesDescription")}</p>
        <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm">
          {setup.backupCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
      </div>
      <form
        noValidate
        onSubmit={form.handleSubmit(async ({ code }) => {
          const { error } = await authClient.twoFactor.verifyTotp({ code });
          if (error) {
            // Clear the rejected code so the next one can be typed straight in.
            form.setValue("code", "");
            form.setError("code", { message: errorMessage(error) });
            return;
          }
          toast.success(t("enabled"));
          await onDone();
        })}
      >
        <FieldGroup>
          <OtpField control={form.control} name="code" label={tAuth("code")} />
          <Button type="submit" className="self-start" disabled={form.formState.isSubmitting}>
            {t("enable")}
          </Button>
        </FieldGroup>
      </form>
    </div>
  );
}
