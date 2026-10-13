import { zodResolver } from "@hookform/resolvers/zod";
import { router } from "expo-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslations } from "use-intl";
import * as z from "zod";
import { FormField } from "@/components/form-field";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useAuthErrorMessage, useAuthSchemas } from "@/hooks/use-auth";
import { authClient } from "@/lib/auth-client";

export default function TwoFactor() {
  const t = useTranslations();
  const errorMessage = useAuthErrorMessage();
  const schemas = useAuthSchemas();
  const [useBackup, setUseBackup] = useState(false);
  const schema = z.object({
    code: useBackup ? z.string().trim().min(1, t("validation.required")) : schemas.otp,
  });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { code: "" } });

  const submit = form.handleSubmit(async ({ code }) => {
    const { error } = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code })
      : await authClient.twoFactor.verifyTotp({ code });
    if (error) {
      form.setValue("code", "");
      form.setError("code", { message: errorMessage(error) });
      return;
    }
    router.replace("/");
  });

  return (
    <Screen title={t("auth.twoFactorTitle")} description={t("auth.twoFactorDescription")}>
      <FormField
        control={form.control}
        name="code"
        label={useBackup ? t("auth.backupCode") : t("auth.code")}
        keyboardType={useBackup ? "default" : "number-pad"}
        autoComplete="one-time-code"
        autoCapitalize="none"
        onSubmitEditing={submit}
      />
      <Button onPress={submit} disabled={form.formState.isSubmitting}>
        <Text>{t("common.continue")}</Text>
      </Button>
      <Button
        variant="ghost"
        onPress={() => {
          setUseBackup(!useBackup);
          form.reset({ code: "" });
        }}
      >
        <Text>{useBackup ? t("auth.useAuthenticator") : t("auth.useBackupCode")}</Text>
      </Button>
    </Screen>
  );
}
