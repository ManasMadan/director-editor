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
import { useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";
import { TextField } from "@/components/form-fields";
import { authClient } from "@/lib/auth-client";
import { useAuthErrorMessage, useAuthSchemas } from "@/modules/auth";

export function PasswordCard() {
  const t = useTranslations("settings.security.password");
  const errorMessage = useAuthErrorMessage();
  const schemas = useAuthSchemas();
  const schema = z.object({ currentPassword: schemas.password, newPassword: schemas.newPassword });
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: "", newPassword: "" },
  });

  async function onSubmit(values: z.infer<typeof schema>) {
    // Other devices are signed out: whoever might know the old password loses access.
    const { error } = await authClient.changePassword({ ...values, revokeOtherSessions: true });
    if (error) {
      form.setError(error.code === "INVALID_PASSWORD" ? "currentPassword" : "newPassword", {
        message: errorMessage(error),
      });
      return;
    }
    form.reset();
    toast.success(t("changed"));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <FieldGroup>
            <TextField
              control={form.control}
              name="currentPassword"
              label={t("current")}
              type="password"
              autoComplete="current-password"
            />
            <TextField
              control={form.control}
              name="newPassword"
              label={t("new")}
              type="password"
              autoComplete="new-password"
            />
            <Button type="submit" className="self-start" disabled={form.formState.isSubmitting}>
              {t("change")}
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
