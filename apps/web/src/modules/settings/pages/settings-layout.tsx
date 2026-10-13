"use client";

import { useSystemInfoQuery } from "@repo/client/api/system/info";
import { cn } from "@repo/ui/lib/utils";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useActiveWorkspace } from "@/modules/workspace";

interface Tab {
  href: Route;
  label: string;
  /** Webhooks and the audit log are for owners and admins. */
  adminOnly?: boolean;
}

function TabLink({ tab, pathname }: { tab: Tab; pathname: string }) {
  const current = tab.href === "/settings" ? pathname === tab.href : pathname.startsWith(tab.href);
  return (
    <Link
      href={tab.href}
      aria-current={current ? "page" : undefined}
      className={cn(
        "-mb-px border-b-2 pb-2 text-sm whitespace-nowrap",
        current
          ? "border-foreground font-medium"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {tab.label}
    </Link>
  );
}

/** Settings for you (profile, security) and for the active workspace, one tab each. */
export function SettingsLayout({ children }: { children: ReactNode }) {
  const t = useTranslations();
  const pathname = usePathname();
  const workspace = useActiveWorkspace();
  const { data: system } = useSystemInfoQuery();
  const personal: Tab[] = [
    { href: "/settings", label: t("settings.profile.title") },
    { href: "/settings/security", label: t("settings.security.title") },
    { href: "/settings/notifications", label: t("notificationSettings.title") },
  ];
  const team: Tab[] = [
    { href: "/settings/workspace", label: t("workspace.nav.general") },
    { href: "/settings/members", label: t("workspace.nav.members") },
    { href: "/settings/webhooks", label: t("workspace.nav.webhooks"), adminOnly: true },
    { href: "/settings/api-keys", label: t("workspace.nav.apiKeys"), adminOnly: true },
    { href: "/settings/audit", label: t("workspace.nav.audit"), adminOnly: true },
    ...(system?.features.billing
      ? [{ href: "/settings/billing" as Route, label: t("billing.title"), adminOnly: true }]
      : []),
  ];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t("settings.title")}</h1>
      <div className="flex flex-col gap-4 sm:flex-row sm:gap-8">
        <nav
          className="flex gap-4 overflow-x-auto border-b"
          aria-label={t("settings.personalTitle")}
        >
          {personal.map((tab) => (
            <TabLink key={tab.href} tab={tab} pathname={pathname} />
          ))}
        </nav>
        <nav
          className="flex gap-4 overflow-x-auto border-b"
          aria-label={t("workspace.switcher.label")}
        >
          {team
            .filter((tab) => !tab.adminOnly || workspace.isAdmin)
            .map((tab) => (
              <TabLink key={tab.href} tab={tab} pathname={pathname} />
            ))}
        </nav>
      </div>
      <div className="flex max-w-2xl flex-col gap-6">{children}</div>
    </div>
  );
}
