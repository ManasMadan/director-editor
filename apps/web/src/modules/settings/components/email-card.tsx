"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { FieldGroup } from "@repo/ui/components/field";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";
import { useCaptcha } from "@/components/captcha";
import { OtpField, TextField } from "@/components/form-fields";
import { authClient } from "@/lib/auth-client";
import { useAuthErrorMessage, useAuthSchemas } from "@/modules/auth";

type Step = { name: "start" } | { name: "current" } | { name: "new"; newEmail: string };

/**
 * Changing the sign-in email, in three steps: a code to the current address proves it's
 * the owner, a code to the new address proves they own it, then the switch. The old
 * address is emailed afterwards (a security alert from the API).
 */
export function EmailCard() {
  const t = useTranslations("settings.profile.email");
  const errorMessage = useAuthErrorMessage();
  const { data: session, refetch } = authClient.useSession();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>({ name: "start" });
  const captcha = useCaptcha();
  const email = session?.user.email ?? "";

  async function sendCurrentCode() {
    const { error } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "email-verification",
      fetchOptions: { headers: captcha.headers() },
    });
    captcha.reset();
    if (error) {
      toast.error(errorMessage(error));
    } else {
      setStep({ name: "current" });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm">
          <span className="text-muted-foreground">{t("current")}: </span>
          <span className="font-medium">{email}</span>
        </p>
        {step.name === "start" ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-muted-foreground">{t("start", { email })}</p>
            {captcha.widget}
            <Button variant="outline" onClick={sendCurrentCode} disabled={!email || !captcha.ready}>
              {t("change")}
            </Button>
          </div>
        ) : null}
        {step.name === "current" ? (
          <RequestChange
            currentEmail={email}
            onSent={(newEmail) => setStep({ name: "new", newEmail })}
          />
        ) : null}
        {step.name === "new" ? (
          <ConfirmChange
            newEmail={step.newEmail}
            onDone={async () => {
              await refetch();
              await queryClient.invalidateQueries();
              toast.success(t("changed", { email: step.newEmail }));
              setStep({ name: "start" });
            }}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function RequestChange({
  currentEmail,
  onSent,
}: {
  currentEmail: string;
  onSent: (newEmail: string) => void;
}) {
  const t = useTranslations("settings.profile.email");
  const errorMessage = useAuthErrorMessage();
  const schemas = useAuthSchemas();
  const schema = z.object({
    otp: schemas.otp,
    newEmail: schemas.email.refine(
      (value: string) => value.toLowerCase() !== currentEmail.toLowerCase(),
      t("sameEmail"),
    ),
  });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { otp: "", newEmail: "" } });

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(async ({ otp, newEmail }) => {
        const { error } = await authClient.emailOtp.requestEmailChange({ newEmail, otp });
        if (error) {
          form.setValue("otp", "");
          form.setError("otp", { message: errorMessage(error) });
          return;
        }
        onSent(newEmail);
      })}
    >
      <FieldGroup>
        <OtpField
          control={form.control}
          name="otp"
          label={t("currentCode", { email: currentEmail })}
        />
        <TextField
          control={form.control}
          name="newEmail"
          label={t("newEmail")}
          type="email"
          autoComplete="email"
        />
        <Button type="submit" className="self-start" disabled={form.formState.isSubmitting}>
          {t("sendNew")}
        </Button>
      </FieldGroup>
    </form>
  );
}

function ConfirmChange({ newEmail, onDone }: { newEmail: string; onDone: () => Promise<void> }) {
  const t = useTranslations("settings.profile.email");
  const errorMessage = useAuthErrorMessage();
  const schema = z.object({ otp: useAuthSchemas().otp });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { otp: "" } });

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(async ({ otp }) => {
        const { error } = await authClient.emailOtp.changeEmail({ newEmail, otp });
        if (error) {
          form.setValue("otp", "");
          form.setError("otp", { message: errorMessage(error) });
          return;
        }
        await onDone();
      })}
    >
      <FieldGroup>
        <OtpField control={form.control} name="otp" label={t("newCode", { email: newEmail })} />
        <Button type="submit" className="self-start" disabled={form.formState.isSubmitting}>
          {t("confirm")}
        </Button>
      </FieldGroup>
    </form>
  );
}
