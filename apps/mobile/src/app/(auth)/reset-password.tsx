import { zodResolver } from "@hookform/resolvers/zod";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useForm } from "react-hook-form";
import { useTranslations } from "use-intl";
import * as z from "zod";
import { FormField } from "@/components/form-field";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useAuthErrorMessage, useAuthSchemas } from "@/hooks/use-auth";
import { authClient } from "@/lib/auth-client";

export default function ResetPassword() {
  const t = useTranslations();
  const errorMessage = useAuthErrorMessage();
  const schemas = useAuthSchemas();
  const { email } = useLocalSearchParams<{ email?: string }>();
  const schema = z.object({ otp: schemas.otp, password: schemas.newPassword });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { otp: "", password: "" } });
  if (!email || !z.email().safeParse(email).success) {
    return <Redirect href="/forgot-password" />;
  }

  // An arrow function keeps the check above narrowing `email` (a declaration is hoisted).
  const submit = form.handleSubmit(async ({ otp, password }) => {
    const { error } = await authClient.emailOtp.resetPassword({ email, otp, password });
    if (error) {
      // Clear the rejected code so the next one can be typed straight in.
      form.setValue("otp", "");
      form.setError("otp", { message: errorMessage(error) });
      return;
    }
    // Every session, this device's included, was signed out by the reset
    // (revokeSessionsOnPasswordReset): sign in again with the new password.
    router.replace({ pathname: "/sign-in", params: { reset: "done" } });
  });

  return (
    <Screen title={t("auth.resetTitle")} description={t("auth.resetDescription", { email })}>
      <FormField
        control={form.control}
        name="otp"
        label={t("auth.code")}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={6}
      />
      <FormField
        control={form.control}
        name="password"
        label={t("auth.newPassword")}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
        onSubmitEditing={submit}
      />
      <Button onPress={submit} disabled={form.formState.isSubmitting}>
        <Text>{t("common.continue")}</Text>
      </Button>
    </Screen>
  );
}
