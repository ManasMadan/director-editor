"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@repo/ui/components/button";
import { FieldGroup } from "@repo/ui/components/field";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";
import { useCaptcha } from "@/components/captcha";
import { OtpField } from "@/components/form-fields";
import { authClient } from "@/lib/auth-client";
import { AuthCard } from "../components/auth-card";
import { useAuthErrorMessage } from "../hooks/use-auth-error";
import { useFinishSignIn } from "../hooks/use-finish-sign-in";
import { useEmailParam } from "../hooks/use-next-path";
import { useAuthSchemas } from "../hooks/use-schemas";

export function VerifyEmailPage() {
  const t = useTranslations();
  const router = useRouter();
  const email = useEmailParam();
  const done = useFinishSignIn();
  const errorMessage = useAuthErrorMessage();
  const captcha = useCaptcha();
  const schema = z.object({ otp: useAuthSchemas().otp });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { otp: "" } });

  useEffect(() => {
    if (!email) {
      router.replace("/sign-in");
    }
  }, [email, router]);
  if (!email) {
    return null;
  }
  // The handlers below only exist once an address is known.
  const address = email;

  async function onSubmit({ otp }: z.infer<typeof schema>) {
    const { data, error } = await authClient.emailOtp.verifyEmail({ email: address, otp });
    if (error) {
      // Clear the rejected code so the next one can be typed straight in.
      form.setValue("otp", "");
      form.setError("otp", { message: errorMessage(error) });
      return;
    }
    // Verification signs the user in (autoSignInAfterVerification).
    toast.success(t("auth.verified"));
    done(data);
  }

  async function resend() {
    const { error } = await authClient.emailOtp.sendVerificationOtp({
      email: address,
      type: "email-verification",
      fetchOptions: { headers: captcha.headers() },
    });
    captcha.reset();
    if (error) {
      toast.error(errorMessage(error));
    } else {
      form.reset({ otp: "" });
      toast.success(t("auth.codeSent"));
    }
  }

  return (
    <AuthCard title={t("auth.verifyTitle")} description={t("auth.verifyDescription", { email })}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <FieldGroup>
          <OtpField control={form.control} name="otp" label={t("auth.code")} />
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {t("common.continue")}
          </Button>
          {captcha.widget}
          <Button type="button" variant="ghost" onClick={resend} disabled={!captcha.ready}>
            {t("auth.resendCode")}
          </Button>
        </FieldGroup>
      </form>
    </AuthCard>
  );
}
