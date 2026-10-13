import { buttonVariants } from "@repo/ui/components/button";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

/** The public landing page. Server-rendered: no client JavaScript beyond the shell. */
export async function HomePage({ signedIn }: { signedIn: boolean }) {
  const t = await getTranslations("home");
  return (
    <section className="flex flex-col items-start gap-6 py-16">
      <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
        {t("title")}
      </h1>
      <p className="max-w-xl text-lg text-muted-foreground">{t("subtitle")}</p>
      <Link href={signedIn ? "/dashboard" : "/sign-up"} className={buttonVariants({ size: "lg" })}>
        {signedIn ? t("ctaSignedIn") : t("cta")}
      </Link>
    </section>
  );
}
