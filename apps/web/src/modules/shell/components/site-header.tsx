"use client";

import { buttonVariants } from "@repo/ui/components/button";
import { GeminiShimmer } from "@repo/ui/components/gemini-loader";
import { cn } from "@repo/ui/lib/utils";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { authClient } from "@/lib/auth-client";
import { HOME_PATH, matchesPath, onStage } from "@/lib/routes";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";

/** Where a member goes from the header. */
const NAV: { href: Route; label: "library" | "media" }[] = [
  { href: "/library", label: "library" },
  { href: "/media", label: "media" },
];

/** On the dark bar, a control's hover and open states stay on the bar's own colours. */
const ON_BAR =
  "size-11 text-studio-foreground hover:bg-studio-foreground/10 hover:text-studio-foreground aria-expanded:bg-studio-foreground/10 aria-expanded:text-studio-foreground dark:hover:bg-studio-foreground/10";

function Nav() {
  const t = useTranslations("common");
  // Null outside a navigation (a server render with no path): nothing is current then.
  const pathname: string | null = usePathname();
  return (
    // Scrolls on its own rather than pushing the page sideways at a large text size.
    <nav aria-label={t("nav")} className="min-w-0 overflow-x-auto [scrollbar-width:none]">
      <ul className="flex items-center gap-0.5 sm:gap-1">
        {NAV.map(({ href, label }) => {
          const active = pathname !== null && matchesPath(pathname, [href]);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 items-center rounded-full px-2.5 text-sm font-medium whitespace-nowrap transition-colors sm:px-3",
                  active
                    ? "bg-studio-foreground/12 text-studio-foreground"
                    : "text-studio-foreground/70 hover:text-studio-foreground",
                )}
              >
                {t(label)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Director's bar across the top of every page but the immersive ones: the wordmark, where
 * a member can go, and their account. It stays on the dark stage in both themes, as the
 * brand's own bar.
 */
export function SiteHeader() {
  const t = useTranslations("common");
  const { data: session, isPending } = authClient.useSession();
  const pathname: string | null = usePathname();

  return (
    <header className="sticky top-0 z-30 border-b border-studio-foreground/10 bg-studio/95 text-studio-foreground backdrop-blur">
      {/* The first Tab stop: past the header to the page itself. */}
      <a
        href="#main"
        className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:top-2 focus-visible:left-2 focus-visible:z-40 focus-visible:rounded-full focus-visible:bg-studio-foreground focus-visible:px-4 focus-visible:py-2.5 focus-visible:text-sm focus-visible:font-semibold focus-visible:text-studio"
      >
        {t("skipToContent")}
      </a>
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-2 px-4 sm:gap-3">
        <Link
          href={session ? HOME_PATH : "/"}
          className="flex min-h-11 items-center gap-2 text-[1.05rem] font-semibold tracking-tight"
        >
          <span
            aria-hidden
            className="size-2.5 rounded-full bg-record shadow-[0_0_0_3px] shadow-record/25"
          />
          {/* Under 380 px the name gives way to the nav, which then fits on one line. */}
          <span className="max-[379px]:sr-only">{t("appName")}</span>
        </Link>
        {session ? <Nav /> : null}
        <div className="ml-auto flex items-center gap-1">
          {/* Director's own pages stay dark whatever the theme: a toggle there would do nothing. */}
          {onStage(pathname) ? null : <ThemeToggle className={ON_BAR} />}
          {isPending && !session ? (
            <GeminiShimmer className="h-8 w-20 rounded-full bg-studio-foreground/10" />
          ) : null}
          {session ? <UserMenu user={session.user} className={ON_BAR} /> : null}
          {!isPending && !session ? (
            <Link
              href="/sign-in"
              className={buttonVariants({
                size: "sm",
                className: "bg-studio-foreground text-studio hover:bg-studio-foreground/90",
              })}
            >
              {t("signIn")}
            </Link>
          ) : null}
        </div>
      </div>
    </header>
  );
}
