import { zodResolver } from "@hookform/resolvers/zod";
import { Link, router } from "expo-router";
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
import { useCaptcha } from "@/lib/captcha";

export default function ForgotPassword() {
  const t = useTranslations();
  const errorMessage = useAuthErrorMessage();
  const captcha = useCaptcha();
  const [failure, setFailure] = useState<string>();
  const schema = z.object({ email: useAuthSchemas().email });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { email: "" } });

  const submit = form.handleSubmit(async ({ email }) => {
    setFailure(undefined);
    const headers = await captcha();
    if (!headers) {
      setFailure(t("mobile.captchaCancelled"));
      return;
    }
    // Answers the same whether or not the account exists, so emails can't be enumerated.
    const { error } = await authClient.emailOtp.requestPasswordReset({
      email,
      fetchOptions: { headers },
    });
    if (error) {
      setFailure(errorMessage(error));
      return;
    }
    router.push({ pathname: "/reset-password", params: { email } });
  });

  return (
    <Screen title={t("auth.forgotTitle")} description={t("auth.forgotDescription")}>
      <FormField
        control={form.control}
        name="email"
        label={t("common.email")}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="username"
        onSubmitEditing={submit}
      />
      {failure ? (
        <Text role="alert" className="text-destructive">
          {failure}
        </Text>
      ) : null}
      <Button onPress={submit} disabled={form.formState.isSubmitting}>
        <Text>{t("auth.sendCode")}</Text>
      </Button>
      <Link href="/sign-in" className="self-center">
        <Text className="underline">{t("auth.backToSignIn")}</Text>
      </Link>
    </Screen>
  );
}
