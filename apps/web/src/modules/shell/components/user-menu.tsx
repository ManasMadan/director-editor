"use client";

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
import { cn } from "@repo/ui/lib/utils";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { authClient } from "@/lib/auth-client";

interface UserMenuProps {
  className?: string;
  user: {
    name: string;
    email: string;
    image?: string | null | undefined;
    /** Set for a demo guest: when it's deleted. Its address is a made-up one. */
    guestUntil?: Date | null | undefined;
  };
}

export function UserMenu({ user, className }: UserMenuProps) {
  const t = useTranslations("common");
  const router = useRouter();

  async function signOut() {
    await authClient.signOut();
    // A full page load, not a client-side navigation: nothing from this account (cached
    // queries, open streams, in-memory state) survives for the next person at the
    // keyboard, and no mounted component refetches as a signed-out user in between.
    window.location.assign("/");
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className={cn("rounded-full", className)}
            aria-label={user.name}
          />
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
            {/* A guest's address means nothing to them; what matters is that it's for a day. */}
            <div className="text-xs text-muted-foreground">
              {user.guestUntil ? t("guestNote") : user.email}
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push("/settings")}>
          {t("settings")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={signOut}>{t("signOut")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
