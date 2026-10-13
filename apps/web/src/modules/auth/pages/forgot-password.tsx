"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@repo/ui/components/button";
import { FieldGroup } from "@repo/ui/components/field";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";
import { useCaptcha } from "@/components/captcha";
import { TextField } from "@/components/form-fields";
import { authClient } from "@/lib/auth-client";
import { AuthCard } from "../components/auth-card";
import { useAuthErrorMessage } from "../hooks/use-auth-error";
import { useAuthSchemas } from "../hooks/use-schemas";

export function ForgotPasswordPage() {
  const t = useTranslations();
  const router = useRouter();
  const errorMessage = useAuthErrorMessage();
  const captcha = useCaptcha();
  const schema = z.object({ email: useAuthSchemas().email });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { email: "" } });

  async function onSubmit({ email }: z.infer<typeof schema>) {
    // Answers the same whether or not the account exists, so emails can't be enumerated.
    const { error } = await authClient.emailOtp.requestPasswordReset({
      email,
      fetchOptions: { headers: captcha.headers() },
    });
    captcha.reset();
    if (error) {
      toast.error(errorMessage(error));
      return;
    }
    router.push(`/reset-password?email=${encodeURIComponent(email)}`);
  }

  return (
    <AuthCard title={t("auth.forgotTitle")} description={t("auth.forgotDescription")}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <FieldGroup>
          <TextField
            control={form.control}
            name="email"
            label={t("common.email")}
            type="email"
            autoComplete="email"
          />
          {captcha.widget}
          <Button type="submit" disabled={form.formState.isSubmitting || !captcha.ready}>
            {t("auth.sendCode")}
          </Button>
          <Link href="/sign-in" className="text-center text-sm underline underline-offset-4">
            {t("auth.backToSignIn")}
          </Link>
        </FieldGroup>
      </form>
    </AuthCard>
  );
}
