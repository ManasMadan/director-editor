import { zodResolver } from "@hookform/resolvers/zod";
import { Redirect, router, useLocalSearchParams } from "expo-router";
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

export default function VerifyEmail() {
  const t = useTranslations();
  const errorMessage = useAuthErrorMessage();
  const schemas = useAuthSchemas();
  const captcha = useCaptcha();
  const { email } = useLocalSearchParams<{ email?: string }>();
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const schema = z.object({ otp: schemas.otp });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { otp: "" } });
  if (!email || !z.email().safeParse(email).success) {
    return <Redirect href="/sign-in" />;
  }

  const submit = form.handleSubmit(async ({ otp }) => {
    const { error } = await authClient.emailOtp.verifyEmail({ email, otp });
    if (error) {
      // Clear the rejected code so the next one can be typed straight in.
      form.setValue("otp", "");
      form.setError("otp", { message: errorMessage(error) });
      return;
    }
    // Verification signs the user in (autoSignInAfterVerification).
    router.replace("/");
  });

  // An arrow function keeps the check above narrowing `email` (a declaration is hoisted).
  const resend = async () => {
    const headers = await captcha();
    if (!headers) {
      setNotice({ text: t("mobile.captchaCancelled"), error: true });
      return;
    }
    const { error } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "email-verification",
      fetchOptions: { headers },
    });
    setNotice(
      error
        ? { text: errorMessage(error), error: true }
        : { text: t("auth.codeSent"), error: false },
    );
  };

  return (
    <Screen title={t("auth.verifyTitle")} description={t("auth.verifyDescription", { email })}>
      <FormField
        control={form.control}
        name="otp"
        label={t("auth.code")}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={6}
        onSubmitEditing={submit}
      />
      {notice ? (
        <Text
          role={notice.error ? "alert" : "status"}
          className={notice.error ? "text-destructive" : ""}
        >
          {notice.text}
        </Text>
      ) : null}
      <Button onPress={submit} disabled={form.formState.isSubmitting}>
        <Text>{t("common.continue")}</Text>
      </Button>
      <Button variant="ghost" onPress={resend}>
        <Text>{t("auth.resendCode")}</Text>
      </Button>
    </Screen>
  );
}
