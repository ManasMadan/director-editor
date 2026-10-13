"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { errorCode, useApiErrorMessage } from "@repo/client";
import { useMeQuery } from "@repo/client/api/user/me";
import { useRemovePhoneMutation } from "@repo/client/api/user/remove-phone";
import { useSendPhoneCodeMutation } from "@repo/client/api/user/send-phone-code";
import { useVerifyPhoneMutation } from "@repo/client/api/user/verify-phone";
import { phoneNumberSchema } from "@repo/contracts/auth";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { FieldGroup } from "@repo/ui/components/field";
import { Skeleton } from "@repo/ui/components/skeleton";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";
import { OtpField, TextField } from "@/components/form-fields";
import { useAuthSchemas } from "@/modules/auth";
import { ReauthPrompt } from "./reauth-prompt";

type Step = { name: "view" } | { name: "number" } | { name: "code"; phoneNumber: string };

/**
 * The account's phone number, for security texts. Adding or changing it texts a code to
 * the new number first; the API alerts the account (and the previous number) afterwards.
 */
export function PhoneCard() {
  const t = useTranslations("settings.security.phone");
  const errorMessage = useApiErrorMessage();
  const me = useMeQuery();
  const [step, setStep] = useState<Step>({ name: "view" });
  const [stale, setStale] = useState(false);

  const handle = (error: unknown) => {
    if (errorCode(error) === "FRESH_SESSION_REQUIRED") {
      setStale(true);
    } else {
      toast.error(errorMessage(error));
    }
  };

  let content: ReactNode;
  if (stale) {
    content = <ReauthPrompt />;
  } else if (!me.data) {
    content = <Skeleton className="h-9 w-48" />;
  } else if (step.name === "view") {
    content = (
      <CurrentNumber
        phoneNumber={me.data.phoneNumber}
        onChange={() => setStep({ name: "number" })}
        onError={handle}
      />
    );
  } else if (step.name === "number") {
    content = (
      <NumberStep
        onSent={(number) => setStep({ name: "code", phoneNumber: number })}
        onCancel={() => setStep({ name: "view" })}
        onError={handle}
      />
    );
  } else {
    content = (
      <CodeStep
        phoneNumber={step.phoneNumber}
        onDone={() => {
          toast.success(t("verified"));
          setStep({ name: "view" });
        }}
        onBack={() => setStep({ name: "number" })}
        onError={handle}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{content}</CardContent>
    </Card>
  );
}

/** The number on the account (or none), with buttons to change or remove it. */
function CurrentNumber({
  phoneNumber,
  onChange,
  onError,
}: {
  phoneNumber: string | null;
  onChange: () => void;
  onError: (error: unknown) => void;
}) {
  const t = useTranslations("settings.security.phone");
  const remove = useRemovePhoneMutation();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-sm">
        {phoneNumber ? (
          <span className="font-medium">{phoneNumber}</span>
        ) : (
          <span className="text-muted-foreground">{t("none")}</span>
        )}
      </p>
      <Button variant="outline" size="sm" onClick={onChange}>
        {phoneNumber ? t("change") : t("add")}
      </Button>
      {phoneNumber ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(undefined, {
              onSuccess: () => toast.success(t("removed")),
              onError,
            })
          }
        >
          {t("remove")}
        </Button>
      ) : null}
    </div>
  );
}

interface StepProps {
  onError: (error: unknown) => void;
}

function NumberStep({
  onSent,
  onCancel,
  onError,
}: StepProps & { onSent: (phoneNumber: string) => void; onCancel: () => void }) {
  const t = useTranslations("settings.security.phone");
  const send = useSendPhoneCodeMutation();
  const schema = z.object({ phoneNumber: useAuthSchemas().phone });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { phoneNumber: "" } });

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(async ({ phoneNumber }) => {
        // The number as the API will store it, so the next step shows (and sends) that.
        const normalized = phoneNumberSchema.parse(phoneNumber);
        try {
          await send.mutateAsync({ phoneNumber: normalized });
          onSent(normalized);
        } catch (error) {
          onError(error);
        }
      })}
    >
      <FieldGroup>
        <TextField
          control={form.control}
          name="phoneNumber"
          label={t("number")}
          type="tel"
          autoComplete="tel"
          placeholder="+14155550123"
        />
        <div className="flex gap-2">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {t("sendCode")}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("cancel")}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

function CodeStep({
  phoneNumber,
  onDone,
  onBack,
  onError,
}: StepProps & { phoneNumber: string; onDone: () => void; onBack: () => void }) {
  const t = useTranslations("settings.security.phone");
  const errorMessage = useApiErrorMessage();
  const verify = useVerifyPhoneMutation();
  const resend = useSendPhoneCodeMutation();
  const schema = z.object({ code: useAuthSchemas().otp });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { code: "" } });

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(async ({ code }) => {
        try {
          await verify.mutateAsync({ phoneNumber, code });
          onDone();
        } catch (error) {
          if (errorCode(error) === "FRESH_SESSION_REQUIRED") {
            return onError(error);
          }
          form.setValue("code", "");
          form.setError("code", { message: errorMessage(error) });
        }
      })}
    >
      <FieldGroup>
        <p className="text-sm text-muted-foreground">{t("codeSent", { phoneNumber })}</p>
        <OtpField control={form.control} name="code" label={t("code")} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {t("verify")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={resend.isPending}
            onClick={() =>
              resend.mutate(
                { phoneNumber },
                {
                  onSuccess: () => toast.success(t("codeSent", { phoneNumber })),
                  onError,
                },
              )
            }
          >
            {t("resend")}
          </Button>
          <Button type="button" variant="ghost" onClick={onBack}>
            {t("cancel")}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
