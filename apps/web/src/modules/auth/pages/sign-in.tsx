"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useSystemInfoQuery } from "@repo/client/api/system/info";
import { Button } from "@repo/ui/components/button";
import { FieldGroup, FieldSeparator } from "@repo/ui/components/field";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";
import { TextField } from "@/components/form-fields";
import { authClient } from "@/lib/auth-client";
import { AuthCard } from "../components/auth-card";
import { useAuthErrorMessage } from "../hooks/use-auth-error";
import { useFinishSignIn } from "../hooks/use-finish-sign-in";
import { useAuthStepHref, useNextPath } from "../hooks/use-next-path";
import { useAuthSchemas } from "../hooks/use-schemas";

export function SignInPage() {
  const t = useTranslations();
  const router = useRouter();
  const next = useNextPath();
  const stepHref = useAuthStepHref();
  const errorMessage = useAuthErrorMessage();
  const { data: system } = useSystemInfoQuery();
  const schemas = useAuthSchemas();
  const schema = z.object({ email: schemas.email, password: schemas.password });
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });

  const done = useFinishSignIn();

  async function onSubmit(values: z.infer<typeof schema>) {
    const { data, error } = await authClient.signIn.email(values);
    if (error) {
      // The server has already emailed a fresh code (sendOnSignIn).
      if (error.code === "EMAIL_NOT_VERIFIED") {
        router.push(stepHref("/verify-email", values.email));
        return;
      }
      toast.error(errorMessage(error));
      return;
    }
    // With two-step verification on, the auth client continues on /two-factor instead.
    if (!(data && "twoFactorRedirect" in data && data.twoFactorRedirect)) {
      done(data);
    }
  }

  async function signInWithPasskey() {
    const result = await authClient.signIn.passkey();
    if (!result?.error) {
      done(result?.data);
    } else {
      toast.error(errorMessage(result.error));
    }
  }

  return (
    <AuthCard title={t("auth.signInTitle")} description={t("auth.signInDescription")}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <FieldGroup>
          <TextField
            control={form.control}
            name="email"
            label={t("common.email")}
            type="email"
            autoComplete="username webauthn"
          />
          <TextField
            control={form.control}
            name="password"
            label={t("common.password")}
            type="password"
            autoComplete="current-password"
          />
          <Link
            href="/forgot-password"
            className="-mt-2 text-sm underline-offset-4 hover:underline"
          >
            {t("auth.forgotPassword")}
          </Link>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {t("common.signIn")}
          </Button>
          <FieldSeparator>{t("common.or")}</FieldSeparator>
          <Button type="button" variant="outline" onClick={signInWithPasskey}>
            {t("auth.passkey")}
          </Button>
          {system?.features.google ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => authClient.signIn.social({ provider: "google", callbackURL: next })}
            >
              {t("auth.google")}
            </Button>
          ) : null}
          <p className="text-center text-sm text-muted-foreground">
            {t("auth.noAccount")}{" "}
            <Link
              href={stepHref("/sign-up")}
              className="text-foreground underline underline-offset-4"
            >
              {t("common.signUp")}
            </Link>
          </p>
        </FieldGroup>
      </form>
    </AuthCard>
  );
}
