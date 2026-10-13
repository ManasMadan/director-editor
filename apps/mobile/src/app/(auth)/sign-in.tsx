import { zodResolver } from "@hookform/resolvers/zod";
import { useSystemInfoQuery } from "@repo/client/api/system/info";
import { Link, router, useLocalSearchParams } from "expo-router";
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
import { authClient, signInWithGoogle } from "@/lib/auth-client";
import { passkeysSupported, signInWithPasskey } from "@/lib/passkeys";

export default function SignIn() {
  const t = useTranslations();
  const errorMessage = useAuthErrorMessage();
  const schemas = useAuthSchemas();
  const { data: system } = useSystemInfoQuery();
  // Set by a finished password reset (reset-password.tsx).
  const { reset } = useLocalSearchParams<{ reset?: string }>();
  const [failure, setFailure] = useState<string>();
  const schema = z.object({ email: schemas.email, password: schemas.password });
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });

  const submit = form.handleSubmit(async (values) => {
    setFailure(undefined);
    const { data, error } = await authClient.signIn.email(values);
    if (error) {
      // The server has already emailed a fresh code (sendOnSignIn).
      if (error.code === "EMAIL_NOT_VERIFIED") {
        router.push({ pathname: "/verify-email", params: { email: values.email } });
      } else {
        setFailure(errorMessage(error));
      }
      return;
    }
    // With two-step verification on, the auth client continues on /two-factor instead.
    if (!(data && "twoFactorRedirect" in data && data.twoFactorRedirect)) {
      router.replace("/");
    }
  });

  // Google and passkeys: no form, just whether that made a session, and why not.
  const signInWith = async (method: () => Promise<{ signedIn: boolean; error: unknown }>) => {
    setFailure(undefined);
    const { signedIn, error } = await method();
    if (error) {
      setFailure(errorMessage(error));
    }
    if (signedIn) {
      router.replace("/");
    }
  };

  return (
    <Screen title={t("auth.signInTitle")} description={t("auth.signInDescription")}>
      <FormField
        control={form.control}
        name="email"
        label={t("common.email")}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="username"
      />
      <FormField
        control={form.control}
        name="password"
        label={t("common.password")}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        onSubmitEditing={submit}
      />
      <Link href="/forgot-password" className="self-end">
        <Text className="text-sm underline">{t("auth.forgotPassword")}</Text>
      </Link>
      {reset === "done" ? <Text role="status">{t("auth.passwordUpdated")}</Text> : null}
      {failure ? (
        <Text role="alert" className="text-destructive">
          {failure}
        </Text>
      ) : null}
      <Button onPress={submit} disabled={form.formState.isSubmitting}>
        <Text>{t("common.signIn")}</Text>
      </Button>
      {passkeysSupported() ? (
        <Button variant="outline" onPress={() => signInWith(signInWithPasskey)}>
          <Text>{t("auth.passkey")}</Text>
        </Button>
      ) : null}
      {system?.features.google ? (
        <Button variant="outline" onPress={() => signInWith(signInWithGoogle)}>
          <Text>{t("auth.google")}</Text>
        </Button>
      ) : null}
      <View className="flex-row justify-center gap-1">
        <Text className="text-muted-foreground">{t("auth.noAccount")}</Text>
        <Link href="/sign-up">
          <Text className="underline">{t("common.signUp")}</Text>
        </Link>
      </View>
    </Screen>
  );
}
