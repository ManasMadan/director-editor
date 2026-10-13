"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { nameSchema } from "@repo/contracts/auth";
import { Button } from "@repo/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import { FieldGroup } from "@repo/ui/components/field";
import { useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";
import { TextField } from "@/components/form-fields";
import { authClient } from "@/lib/auth-client";
import { useAuthErrorMessage } from "@/modules/auth";
import { useRefreshWorkspaces, useSwitchWorkspace } from "../hooks/use-workspace";

/** URL-safe slug from a name, made unique with a short random suffix. */
function slugFor(name: string) {
  const base = name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .slice(0, 40);
  return `${base || "workspace"}-${crypto.randomUUID().slice(0, 6)}`;
}

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("workspace.create");
  const tValidation = useTranslations("validation");
  const errorMessage = useAuthErrorMessage();
  const switchTo = useSwitchWorkspace();
  const refresh = useRefreshWorkspaces();
  const schema = z.object({
    name: z
      .string()
      .refine((value) => nameSchema.safeParse(value).success, tValidation("required")),
  });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { name: "" } });

  async function onSubmit({ name }: z.infer<typeof schema>) {
    const { data, error } = await authClient.organization.create({
      name: name.trim(),
      slug: slugFor(name),
    });
    if (error || !data) {
      toast.error(errorMessage(error));
      return;
    }
    await refresh();
    await switchTo(data.id);
    toast.success(t("created"));
    form.reset();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="my-4">
            <TextField
              control={form.control}
              name="name"
              label={t("name")}
              autoComplete="organization"
            />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
