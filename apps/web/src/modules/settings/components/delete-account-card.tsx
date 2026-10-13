"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { useAuthErrorMessage } from "@/modules/auth";
import { PasswordConfirm } from "./password-confirm";

export function DeleteAccountCard() {
  const t = useTranslations("settings.security.danger");
  const router = useRouter();
  const queryClient = useQueryClient();
  const errorMessage = useAuthErrorMessage();

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <PasswordConfirm
          label={t("confirm")}
          submit={t("delete")}
          variant="destructive"
          onConfirm={async (password) => {
            const { error } = await authClient.deleteUser({ password });
            if (error) {
              return errorMessage(error);
            }
            queryClient.clear();
            toast.success(t("deleted"));
            router.replace("/");
            router.refresh();
            return undefined;
          }}
        />
      </CardContent>
    </Card>
  );
}
