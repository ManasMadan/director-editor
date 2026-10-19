"use client";

import { cn } from "@repo/ui/lib/utils";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

interface Tab {
  href: Route;
  label: string;
}

function TabLink({ tab, pathname }: { tab: Tab; pathname: string }) {
  const current = tab.href === "/settings" ? pathname === tab.href : pathname.startsWith(tab.href);
  return (
    <Link
      href={tab.href}
      aria-current={current ? "page" : undefined}
      className={cn(
        // As tall as a thumb (44 px), the label sitting on the underline.
        "-mb-px inline-flex min-h-11 items-end border-b-2 pb-2 text-sm whitespace-nowrap",
        current
          ? "border-foreground font-medium"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {tab.label}
    </Link>
  );
}

/** Settings for you: your profile and your account's security, one tab each. */
export function SettingsLayout({ children }: { children: ReactNode }) {
  const t = useTranslations();
  const pathname = usePathname();
  const tabs: Tab[] = [
    { href: "/settings", label: t("settings.profile.title") },
    { href: "/settings/security", label: t("settings.security.title") },
  ];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t("settings.title")}</h1>
      <nav className="flex gap-4 overflow-x-auto border-b" aria-label={t("settings.personalTitle")}>
        {tabs.map((tab) => (
          <TabLink key={tab.href} tab={tab} pathname={pathname} />
        ))}
      </nav>
      <div className="flex max-w-2xl flex-col gap-6">{children}</div>
    </div>
  );
}
