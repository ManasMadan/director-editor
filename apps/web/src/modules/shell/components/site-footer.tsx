import Link from "next/link";
import { getTranslations } from "next-intl/server";

/** The site's footer, below the page column (SiteChrome): the legal pages. */
export async function SiteFooter() {
  const t = await getTranslations("legal");
  return (
    <footer className="border-t">
      <div className="mx-auto flex w-full max-w-5xl justify-end px-4 py-6 text-sm text-muted-foreground">
        <nav aria-label={t("nav")} className="flex gap-4">
          <Link href="/terms" className="hover:text-foreground">
            {t("terms")}
          </Link>
          <Link href="/privacy" className="hover:text-foreground">
            {t("privacy")}
          </Link>
        </nav>
      </div>
    </footer>
  );
}
