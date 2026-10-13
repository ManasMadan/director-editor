"use client";

import "@repo/ui/globals.css";
import { negotiateLocale } from "@repo/i18n/locales";
import en from "@repo/i18n/messages/en.json" with { type: "json" };
import es from "@repo/i18n/messages/es.json" with { type: "json" };
import { useEffect, useState } from "react";

// Shown when the root layout itself fails, so no providers (and no next-intl) exist.
// It renders its own <html> and picks the language from the browser.
const copy = {
  en: { ...en.errorPage, retry: en.common.retry },
  es: { ...es.errorPage, retry: es.common.retry },
};

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [locale, setLocale] = useState<keyof typeof copy>("en");
  useEffect(() => setLocale(negotiateLocale(navigator.languages)), []);
  const t = copy[locale];
  return (
    <html lang={locale}>
      <body className="mx-auto flex min-h-dvh max-w-5xl flex-col items-start justify-center gap-4 px-4 font-sans">
        <h1 className="text-3xl font-semibold tracking-tight">{t.errorTitle}</h1>
        <p>{t.errorDescription}</p>
        {error.digest ? <p className="font-mono text-xs">{error.digest}</p> : null}
        <button type="button" className="rounded-lg border px-3 py-1.5 text-sm" onClick={reset}>
          {t.retry}
        </button>
      </body>
    </html>
  );
}
