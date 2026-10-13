"use client";

import { useSystemInfoQuery } from "@repo/client/api/system/info";
import { Avatar, AvatarFallback, AvatarImage } from "@repo/ui/components/avatar";
import { Button } from "@repo/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { authClient } from "@/lib/auth-client";
import { forgetBrowserPush } from "@/modules/notifications";

interface UserMenuProps {
  user: { name: string; email: string; image?: string | null | undefined };
}

export function UserMenu({ user }: UserMenuProps) {
  const t = useTranslations("common");
  const router = useRouter();
  const { data: system } = useSystemInfoQuery();

  async function signOut() {
    await authClient.signOut();
    await forgetBrowserPush();
    // A full page load, not a client-side navigation: nothing from this account (cached
    // queries, open streams, in-memory state) survives for the next person at the
    // keyboard, and no mounted component refetches as a signed-out user in between.
    window.location.assign("/");
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" className="rounded-full" aria-label={user.name} />
        }
      >
        <Avatar className="size-8">
          {user.image ? <AvatarImage src={user.image} alt="" /> : null}
          <AvatarFallback>{user.name.slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {/* Base UI requires a label to sit inside a group. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <div className="font-medium">{user.name}</div>
            <div className="text-xs text-muted-foreground">{user.email}</div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push("/dashboard")}>
          {t("dashboard")}
        </DropdownMenuItem>
        {system?.features.ai ? (
          <DropdownMenuItem onClick={() => router.push("/assistant")}>
            {t("assistant")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={() => router.push("/settings")}>
          {t("settings")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={signOut}>{t("signOut")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
