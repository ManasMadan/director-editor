"use client";

import { Button } from "@repo/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import { ChevronsUpDown, Plus } from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { useAuthErrorMessage } from "@/modules/auth";
import {
  isPersonal,
  useActiveWorkspace,
  useSwitchWorkspace,
  useWorkspaces,
} from "../hooks/use-workspace";

// The form (and its validation) loads only when someone opens it: this menu is on every page.
const CreateWorkspaceDialog = dynamic(() =>
  import("./create-workspace-dialog").then((module) => module.CreateWorkspaceDialog),
);

/** Header menu: which workspace you're in, switching between them, creating one. */
export function WorkspaceSwitcher() {
  const t = useTranslations("workspace.switcher");
  const errorMessage = useAuthErrorMessage();
  const workspaces = useWorkspaces();
  const active = useActiveWorkspace();
  const switchTo = useSwitchWorkspace();
  const [creating, setCreating] = useState(false);
  // Mounted from the first open on, so closing still animates.
  const [opened, setOpened] = useState(false);
  const activeId = active.data?.id;
  let activeName = "…";
  if (active.data) {
    activeName = isPersonal(active.data) ? t("personal") : active.data.name;
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="sm" className="max-w-48 gap-1" aria-label={t("label")} />
          }
        >
          <span className="truncate">{activeName}</span>
          <ChevronsUpDown className="size-3.5 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("label")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={activeId ?? ""}
              onValueChange={(id: string) => {
                if (id && id !== activeId) {
                  switchTo(id).catch((error: unknown) => toast.error(errorMessage(error)));
                }
              }}
            >
              {(workspaces.data ?? []).map((workspace) => (
                <DropdownMenuRadioItem key={workspace.id} value={workspace.id}>
                  {isPersonal(workspace) ? t("personal") : workspace.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              setOpened(true);
              setCreating(true);
            }}
          >
            <Plus /> {t("create")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {opened ? <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} /> : null}
    </>
  );
}
