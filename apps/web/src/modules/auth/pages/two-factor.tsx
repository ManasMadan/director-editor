"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@repo/ui/components/button";
import { Checkbox } from "@repo/ui/components/checkbox";
import { Field, FieldGroup, FieldLabel } from "@repo/ui/components/field";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { OtpField, TextField } from "@/components/form-fields";
import { authClient } from "@/lib/auth-client";
import { AuthCard } from "../components/auth-card";
import { useAuthErrorMessage } from "../hooks/use-auth-error";
import { useFinishSignIn } from "../hooks/use-finish-sign-in";
import { useAuthSchemas } from "../hooks/use-schemas";

export function TwoFactorPage() {
  const t = useTranslations();
  const done = useFinishSignIn();
  const errorMessage = useAuthErrorMessage();
  const schemas = useAuthSchemas();
  const [useBackup, setUseBackup] = useState(false);
  const [trustDevice, setTrustDevice] = useState(false);
  const schema = z.object({
    code: useBackup ? z.string().trim().min(1, t("validation.required")) : schemas.otp,
  });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { code: "" } });

  async function onSubmit({ code }: z.infer<typeof schema>) {
    const { data, error } = await (useBackup
      ? authClient.twoFactor.verifyBackupCode({ code, trustDevice })
      : authClient.twoFactor.verifyTotp({ code, trustDevice }));
    if (error) {
      // Clear the rejected code so the next one can be typed straight in.
      form.setValue("code", "");
      form.setError("code", { message: errorMessage(error) });
      return;
    }
    done(data);
  }

  return (
    <AuthCard title={t("auth.twoFactorTitle")} description={t("auth.twoFactorDescription")}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <FieldGroup>
          {useBackup ? (
            <TextField
              control={form.control}
              name="code"
              label={t("auth.backupCode")}
              autoComplete="one-time-code"
            />
          ) : (
            <OtpField control={form.control} name="code" label={t("auth.code")} />
          )}
          <Field orientation="horizontal">
            <Checkbox
              id="trust-device"
              checked={trustDevice}
              onCheckedChange={(checked) => setTrustDevice(checked === true)}
            />
            <FieldLabel htmlFor="trust-device">{t("auth.trustDevice")}</FieldLabel>
          </Field>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {t("common.continue")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setUseBackup(!useBackup);
              form.reset({ code: "" });
            }}
          >
            {useBackup ? t("auth.useAuthenticator") : t("auth.useBackupCode")}
          </Button>
        </FieldGroup>
      </form>
    </AuthCard>
  );
}
