"use client";

import { cn } from "@repo/ui/lib/utils";
import { House, Library, Play } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

const TABS = [
  { href: "/home", label: "home", icon: House },
  { href: "/shorts", label: "shorts", icon: Play },
  { href: "/saved", label: "saved", icon: Library },
] as const;

/** YouTube's bottom bar: Home, Shorts, You. */
export function BottomNav() {
  const t = useTranslations("shorts.nav");
  const pathname = usePathname();
  return (
    <nav
      aria-label={t("label")}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-studio-foreground/10 bg-studio/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <ul className="mx-auto flex max-w-md justify-around">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center gap-0.5 px-5 py-2 text-[0.7rem]",
                  active ? "text-studio-foreground" : "text-studio-foreground/60",
                )}
              >
                <Icon className="size-6" fill={active ? "currentColor" : "none"} aria-hidden />
                {t(label)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
