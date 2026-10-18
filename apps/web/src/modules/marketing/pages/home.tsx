import "@fontsource/gochi-hand/400.css";
import "../landing.css";
import { buttonVariants } from "@repo/ui/components/button";
import type { Route } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { HOME_PATH } from "@/lib/routes";
import { Cloud, Platforms, Proof, Steps, Templates } from "../components/sections";
import { XRayStage } from "../components/xray";

/** Where the demo starts: sign-in, with the demo account filled in. */
const DEMO_PATH: Route = "/sign-in?demo=1";

/**
 * The public landing page (director.mmadan.in), for anyone, signed in or not: the proxy
 * never redirects `/`. Members get "Open Director" where visitors get "Try the demo".
 * Server-rendered, its one moment of motion in CSS: the only client JavaScript beyond the
 * shell is the original Short's play button.
 */
export async function HomePage({ signedIn }: { signedIn: boolean }) {
  const t = await getTranslations("home");
  const cta = signedIn
    ? { href: HOME_PATH, label: t("ctaSignedIn") }
    : { href: DEMO_PATH, label: t("cta") };
  return (
    <div className="flex flex-col gap-20 sm:gap-28">
      {/* The headline spans the hero, a line each, above the pitch and the x-ray. */}
      <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_36rem] lg:gap-x-12">
        <h1 className="text-5xl font-semibold tracking-tighter sm:text-6xl lg:col-span-2 lg:text-7xl lg:leading-[0.95]">
          {t.rich("title", { line: (chunks) => <span className="block">{chunks}</span> })}
        </h1>
        <div className="flex flex-col items-start gap-6">
          <p className="max-w-lg text-lg text-muted-foreground text-pretty">{t("subtitle")}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Link href={cta.href} className={buttonVariants({ size: "lg" })}>
              {cta.label}
            </Link>
            <a href="#how" className={buttonVariants({ size: "lg", variant: "ghost" })}>
              {t("how")}
            </a>
          </div>
        </div>
        <XRayStage />
      </section>
      <Steps />
      <Proof />
      <Templates signedIn={signedIn} />
      <Cloud />
      <Platforms cta={cta} />
    </div>
  );
}
