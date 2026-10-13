"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { nameSchema } from "@repo/contracts/auth";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { FieldGroup } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { Skeleton } from "@repo/ui/components/skeleton";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";
import { TextField } from "@/components/form-fields";
import { authClient } from "@/lib/auth-client";
import { useAuthErrorMessage } from "@/modules/auth";
import {
  isPersonal,
  useActiveWorkspace,
  useRefreshWorkspaces,
  useSwitchWorkspace,
  useWorkspaces,
} from "../hooks/use-workspace";

export function WorkspaceGeneralPage() {
  const t = useTranslations("workspace.general");
  const active = useActiveWorkspace();
  if (!active.data) {
    return <Skeleton className="h-40" />;
  }
  const workspace = active.data;
  const personal = isPersonal(workspace);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>
            {personal ? t("personalNote") : t("description", { name: workspace.name })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RenameForm
            key={workspace.id}
            id={workspace.id}
            name={workspace.name}
            disabled={!active.isAdmin}
          />
        </CardContent>
      </Card>
      {!personal && active.role === "owner" ? (
        <DeleteWorkspaceCard id={workspace.id} name={workspace.name} />
      ) : null}
    </>
  );
}

function RenameForm({ id, name, disabled }: { id: string; name: string; disabled: boolean }) {
  const t = useTranslations("workspace.general");
  const tCommon = useTranslations("common");
  const errorMessage = useAuthErrorMessage();
  const refresh = useRefreshWorkspaces();
  const schema = z.object({
    name: z.string().refine((value) => nameSchema.safeParse(value).success),
  });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { name } });

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(async (values) => {
        const { error } = await authClient.organization.update({
          organizationId: id,
          data: { name: values.name.trim() },
        });
        if (error) {
          return void toast.error(errorMessage(error));
        }
        await refresh();
        form.reset(values);
        toast.success(t("saved"));
      })}
    >
      <FieldGroup>
        <TextField control={form.control} name="name" label={t("name")} disabled={disabled} />
        {disabled ? null : (
          <Button
            type="submit"
            className="self-start"
            disabled={!form.formState.isDirty || form.formState.isSubmitting}
          >
            {tCommon("save")}
          </Button>
        )}
      </FieldGroup>
    </form>
  );
}

function DeleteWorkspaceCard({ id, name }: { id: string; name: string }) {
  const t = useTranslations("workspace.general.delete");
  const errorMessage = useAuthErrorMessage();
  const workspaces = useWorkspaces();
  const switchTo = useSwitchWorkspace();
  const router = useRouter();
  const [confirmation, setConfirmation] = useState("");

  async function remove() {
    // Move to another workspace first, so no request ever runs in a deleted one.
    const next = (await workspaces.refetch()).data?.find((workspace) => workspace.id !== id);
    if (next) {
      await switchTo(next.id);
    }
    const { error } = await authClient.organization.delete({ organizationId: id });
    if (error) {
      return void toast.error(errorMessage(error));
    }
    toast.success(t("deleted"));
    router.replace("/dashboard");
  }

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Label htmlFor="confirm-workspace-delete">{t("confirm")}</Label>
        <Input
          id="confirm-workspace-delete"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder={name}
          autoComplete="off"
        />
        <Button
          variant="destructive"
          className="self-start"
          disabled={confirmation !== name}
          onClick={remove}
        >
          {t("action")}
        </Button>
      </CardContent>
    </Card>
  );
}
