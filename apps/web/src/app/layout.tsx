import "@repo/ui/globals.css";
import { cn } from "@repo/ui/lib/utils";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { getLocale, getMessages, getTimeZone, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { textDirection } from "@/i18n/request";
import { PushSync } from "@/modules/notifications";
import { LiveUpdates, PreferenceSync, SiteHeader } from "@/modules/shell";
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
    <html
      lang={locale}
      dir={textDirection(locale)}
      suppressHydrationWarning
      className={cn(GeistSans.variable, GeistMono.variable)}
    >
      <body className="min-h-dvh font-sans antialiased">
        <Providers locale={locale} timeZone={timeZone} messages={messages} nonce={nonce}>
          <PreferenceSync timeZone={timeZone} />
          <LiveUpdates />
          <PushSync />
          <SiteHeader />
          <main className="mx-auto w-full max-w-5xl px-4 py-10">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
