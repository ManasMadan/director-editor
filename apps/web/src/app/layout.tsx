import "@repo/ui/globals.css";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { getLocale, getMessages, getTimeZone, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { browserMessages, textDirection } from "@/i18n/request";
import { LiveUpdates, PreferenceSync, SiteChrome, SiteFooter, SiteHeader } from "@/modules/shell";
import { Providers } from "./providers";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  return {
    title: { default: t("title"), template: `%s · ${t("title")}` },
    description: t("description"),
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, timeZone, messages, nonce] = await Promise.all([
    getLocale(),
    getTimeZone(),
    getMessages(),
    headers().then((h) => h.get("x-nonce") ?? undefined),
  ]);

  return (
    // next-themes sets the class attribute before hydration; suppress that expected mismatch.
    // No web font: the pages use the system's own (packages/ui's theme), which costs a
    // phone on a slow line nothing to download before the first words show.
    <html lang={locale} dir={textDirection(locale)} suppressHydrationWarning>
      <body className="flex min-h-dvh flex-col font-sans antialiased">
        <Providers
          locale={locale}
          timeZone={timeZone}
          messages={browserMessages(messages)}
          nonce={nonce}
        >
          <PreferenceSync timeZone={timeZone} />
          <LiveUpdates />
          <SiteChrome header={<SiteHeader />} footer={<SiteFooter />}>
            {children}
          </SiteChrome>
        </Providers>
      </body>
    </html>
  );
}
