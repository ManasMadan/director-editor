import { zodResolver } from "@hookform/resolvers/zod";
import { Link, router } from "expo-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { View } from "react-native";
import { useTranslations } from "use-intl";
import * as z from "zod";
import { FormField } from "@/components/form-field";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useAuthErrorMessage, useAuthSchemas } from "@/hooks/use-auth";
import { authClient } from "@/lib/auth-client";
import { useCaptcha } from "@/lib/captcha";
import { deviceLocale, deviceTimeZone } from "@/lib/i18n";

export default function SignUp() {
  const t = useTranslations();
  const errorMessage = useAuthErrorMessage();
  const schemas = useAuthSchemas();
  const captcha = useCaptcha();
  const [failure, setFailure] = useState<string>();
  const schema = z.object({
    name: schemas.name,
    email: schemas.email,
    password: schemas.newPassword,
  });
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { name: "", email: "", password: "" },
  });

  const submit = form.handleSubmit(async (values) => {
    setFailure(undefined);
    const headers = await captcha();
    if (!headers) {
      setFailure(t("mobile.captchaCancelled"));
      return;
    }
    const { error } = await authClient.signUp.email({
      ...values,
      // Emails (starting with the verification code) and dates use these.
      locale: deviceLocale(),
      timezone: deviceTimeZone(),
      fetchOptions: { headers },
    });
    if (error) {
      setFailure(errorMessage(error));
      return;
    }
    router.push({ pathname: "/verify-email", params: { email: values.email } });
  });

  return (
    <Screen title={t("auth.signUpTitle")} description={t("auth.signUpDescription")}>
      <FormField control={form.control} name="name" label={t("common.name")} autoComplete="name" />
      <FormField
        control={form.control}
        name="email"
        label={t("common.email")}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
      />
      <FormField
        control={form.control}
        name="password"
        label={t("common.password")}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
        onSubmitEditing={submit}
      />
      {failure ? (
        <Text role="alert" className="text-destructive">
          {failure}
        </Text>
      ) : null}
      <Button onPress={submit} disabled={form.formState.isSubmitting}>
        <Text>{t("common.signUp")}</Text>
      </Button>
      <View className="flex-row justify-center gap-1">
        <Text className="text-muted-foreground">{t("auth.haveAccount")}</Text>
        <Link href="/sign-in">
          <Text className="underline">{t("common.signIn")}</Text>
        </Link>
      </View>
    </Screen>
  );
}
