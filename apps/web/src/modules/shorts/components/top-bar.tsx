import { Clapperboard, UserRound } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

/** YouTube's top bar, with Director's mark where YouTube's logo goes. */
export function TopBar({ children }: { children?: ReactNode }) {
  const t = useTranslations("shorts");
  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 bg-studio/95 px-4 py-3 backdrop-blur">
      <Link href="/home" className="flex items-center gap-1.5 font-semibold tracking-tight">
        <span className="flex size-7 items-center justify-center rounded-lg bg-record text-record-foreground">
          <Clapperboard className="size-4" aria-hidden />
        </span>
        {t("brand")}
      </Link>
      <div className="ml-auto flex items-center gap-2">
        {children}
        {/* These pages hide the site header: the account (settings, sign-out) is here. */}
        <Link
          href="/settings"
          aria-label={t("account")}
          className="flex size-9 items-center justify-center rounded-full hover:bg-studio-foreground/10"
        >
          <UserRound className="size-5" aria-hidden />
        </Link>
      </div>
    </header>
  );
}
