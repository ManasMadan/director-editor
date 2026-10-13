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
import { OtpField, TextField } from "@/components/form-fields";
import { authClient } from "@/lib/auth-client";
import { AuthCard } from "../components/auth-card";
import { useAuthErrorMessage } from "../hooks/use-auth-error";
import { useEmailParam } from "../hooks/use-next-path";
import { useAuthSchemas } from "../hooks/use-schemas";

export function ResetPasswordPage() {
  const t = useTranslations();
  const router = useRouter();
  const email = useEmailParam();
  const errorMessage = useAuthErrorMessage();
  const schemas = useAuthSchemas();
  const schema = z.object({ otp: schemas.otp, password: schemas.newPassword });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { otp: "", password: "" } });

  useEffect(() => {
    if (!email) {
      router.replace("/forgot-password");
    }
  }, [email, router]);
  if (!email) {
    return null;
  }
  // The handlers below only exist once an address is known.
  const address = email;

  async function onSubmit({ otp, password }: z.infer<typeof schema>) {
    const { error } = await authClient.emailOtp.resetPassword({ email: address, otp, password });
    if (error) {
      // Clear the rejected code so the next one can be typed straight in.
      form.setValue("otp", "");
      form.setError("otp", { message: errorMessage(error) });
      return;
    }
    // Every other session was signed out by the reset (revokeSessionsOnPasswordReset).
    toast.success(t("auth.passwordUpdated"));
    router.replace("/sign-in");
  }

  return (
    <AuthCard title={t("auth.resetTitle")} description={t("auth.resetDescription", { email })}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <FieldGroup>
          <OtpField control={form.control} name="otp" label={t("auth.code")} />
          <TextField
            control={form.control}
            name="password"
            label={t("auth.newPassword")}
            type="password"
            autoComplete="new-password"
          />
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {t("common.continue")}
          </Button>
        </FieldGroup>
      </form>
    </AuthCard>
  );
}
