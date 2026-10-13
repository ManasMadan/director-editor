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
import { useAuthStepHref } from "../hooks/use-next-path";
import { useAuthSchemas } from "../hooks/use-schemas";

export function SignUpPage() {
  const t = useTranslations();
  const router = useRouter();
  const stepHref = useAuthStepHref();
  const errorMessage = useAuthErrorMessage();
  const captcha = useCaptcha();
  const schemas = useAuthSchemas();
  const schema = z.object({
    name: schemas.name,
    email: schemas.email,
    password: schemas.newPassword,
  });
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { name: "", email: "", password: "" },
  });

  async function onSubmit(values: z.infer<typeof schema>) {
    // The language comes from the browser (Accept-Language); the time zone is sent explicitly.
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { error } = await authClient.signUp.email({
      ...values,
      timezone,
      fetchOptions: { headers: captcha.headers() },
    });
    captcha.reset();
    if (error) {
      toast.error(errorMessage(error));
      return;
    }
    router.push(stepHref("/verify-email", values.email));
  }

  return (
    <AuthCard title={t("auth.signUpTitle")} description={t("auth.signUpDescription")}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <FieldGroup>
          <TextField
            control={form.control}
            name="name"
            label={t("common.name")}
            autoComplete="name"
          />
          <TextField
            control={form.control}
            name="email"
            label={t("common.email")}
            type="email"
            autoComplete="email"
          />
          <TextField
            control={form.control}
            name="password"
            label={t("common.password")}
            type="password"
            autoComplete="new-password"
          />
          {captcha.widget}
          <Button type="submit" disabled={form.formState.isSubmitting || !captcha.ready}>
            {t("common.signUp")}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            {t("auth.haveAccount")}{" "}
            <Link
              href={stepHref("/sign-in")}
              className="text-foreground underline underline-offset-4"
            >
              {t("common.signIn")}
            </Link>
          </p>
        </FieldGroup>
      </form>
    </AuthCard>
  );
}
