import { buttonVariants } from "@repo/ui/components/button";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

export default async function NotFound() {
  const t = await getTranslations("errorPage");
  return (
    <section className="flex flex-col items-start gap-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{t("notFoundTitle")}</h1>
      <p className="text-muted-foreground">{t("notFoundDescription")}</p>
      <Link href="/" className={buttonVariants()}>
        {t("home")}
      </Link>
    </section>
  );
}
