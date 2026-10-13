"use client";

import { buttonVariants } from "@repo/ui/components/button";
import { Skeleton } from "@repo/ui/components/skeleton";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { authClient } from "@/lib/auth-client";
import { NotificationBell } from "@/modules/notifications";
import { WorkspaceSwitcher } from "@/modules/workspace";
import { LanguageSwitcher } from "./language-switcher";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";

export function SiteHeader() {
  const t = useTranslations("common");
  const { data: session, isPending } = authClient.useSession();

  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-4 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Link href={session ? "/dashboard" : "/"} className="font-semibold tracking-tight">
            {t("appName")}
          </Link>
          {session ? <WorkspaceSwitcher /> : null}
        </div>
        <nav className="flex items-center gap-2">
          <LanguageSwitcher />
          <ThemeToggle />
          {isPending && !session ? <Skeleton className="h-8 w-20" /> : null}
          {session ? (
            <>
              <NotificationBell />
              <UserMenu user={session.user} />
            </>
          ) : null}
          {!isPending && !session ? (
            <Link href="/sign-in" className={buttonVariants({ size: "sm" })}>
              {t("signIn")}
            </Link>
          ) : null}
        </nav>
      </div>
    </header>
  );
}
