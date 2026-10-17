"use client";

import "@repo/ui/globals.css";
import { type Locale, negotiateLocale } from "@repo/i18n/locales";
import { useEffect, useState } from "react";

// Shown when the root layout itself fails, so no providers (and no next-intl) exist.
// It renders its own <html> and picks the language from the browser.
//
// Every route's first load includes this page, so its words are loaded only when it
// shows: imported up front, every language's whole catalog would ride along on every page.
/** The parts of a catalog this page reads. */
interface Catalog {
  default: {
    errorPage: { errorTitle: string; errorDescription: string };
    common: { retry: string };
  };
}

const catalogs: Record<Locale, () => Promise<Catalog>> = {
  en: () => import("@repo/i18n/messages/en.json"),
};

interface Copy {
  errorTitle: string;
  errorDescription: string;
  retry: string;
}

/** The page's words in the browser's language, once loaded (null until then, or if they can't be). */
function useCopy() {
  const [locale, setLocale] = useState<Locale>("en");
  const [copy, setCopy] = useState<Copy | null>(null);
  useEffect(() => {
    const chosen = negotiateLocale(navigator.languages);
    setLocale(chosen);
    catalogs[chosen]()
      .then(({ default: messages }) =>
        setCopy({ ...messages.errorPage, retry: messages.common.retry }),
      )
      // Nothing more to fetch with: the reference still shows, for support, and the
      // browser reports why.
      .catch(reportError);
  }, []);
  return { locale, copy };
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { locale, copy } = useCopy();
  return (
    <html lang={locale}>
      <body className="mx-auto flex min-h-dvh max-w-5xl flex-col items-start justify-center gap-4 px-4 font-sans">
        {copy ? (
          <>
            <h1 className="text-3xl font-semibold tracking-tight">{copy.errorTitle}</h1>
            <p>{copy.errorDescription}</p>
          </>
        ) : null}
        {error.digest ? <p className="font-mono text-xs">{error.digest}</p> : null}
        {copy ? (
          <button type="button" className="rounded-lg border px-3 py-1.5 text-sm" onClick={reset}>
            {copy.retry}
          </button>
        ) : null}
      </body>
    </html>
  );
}
