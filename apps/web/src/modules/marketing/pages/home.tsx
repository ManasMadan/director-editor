import "@fontsource/gochi-hand/400.css";
import "../landing.css";
import { buttonVariants } from "@repo/ui/components/button";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { HOME_PATH } from "@/lib/routes";
import { HeroChat } from "../components/hero-chat";
import { Cloud, Platforms, Proof, Steps, Templates, XRay } from "../components/sections";
import { DEMO_PATH } from "../lib/demo";

/**
 * The public landing page (director.mmadan.in), for anyone, signed in or not: the proxy
 * never redirects `/`. Members get "Open Director" where visitors get "Try it now, no
 * sign-up", which signs the browser straight in to the demo. Server-rendered, its motion
 * in CSS: the only client JavaScript beyond the shell is the original Short's play button.
 */
export async function HomePage({ signedIn }: { signedIn: boolean }) {
  const t = await getTranslations("home");
  const cta = signedIn
    ? { href: HOME_PATH, label: t("ctaSignedIn") }
    : { href: DEMO_PATH, label: t("cta") };
  return (
    <div className="flex flex-col gap-20 sm:gap-28">
      <section className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-x-16">
        <div className="flex flex-col items-start gap-6">
          <h1 className="text-5xl font-semibold tracking-tighter sm:text-6xl lg:text-7xl lg:leading-[0.95]">
            {t.rich("title", { line: (chunks) => <span className="block">{chunks}</span> })}
          </h1>
          <p className="max-w-lg text-lg text-muted-foreground text-pretty sm:text-xl">
            {t("subtitle")}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link href={cta.href} className={buttonVariants({ size: "lg" })}>
              {cta.label}
            </Link>
            <a href="#how" className={buttonVariants({ size: "lg", variant: "ghost" })}>
              {t("how")}
            </a>
          </div>
        </div>
        <HeroChat />
      </section>
      <Steps />
      <XRay />
      <Proof />
      <Templates signedIn={signedIn} />
      <Cloud />
      <Platforms cta={cta} />
    </div>
  );
}
