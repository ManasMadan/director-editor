import { getFormatter, getTranslations } from "next-intl/server";

// Bump when the text changes; shown to readers as "Last updated".
const LAST_UPDATED = new Date("2026-09-29");

/** Terms and privacy. The copy lives in packages/i18n (`legal.*`) like every other text. */
export async function LegalPage({ document }: { document: "terms" | "privacy" }) {
  const [t, format] = await Promise.all([getTranslations("legal"), getFormatter()]);
  return (
    <article className="flex max-w-2xl flex-col gap-4">
      <h1 className="text-3xl font-semibold tracking-tight">{t(document)}</h1>
      <p className="text-sm text-muted-foreground">
        {t("lastUpdated", { date: format.dateTime(LAST_UPDATED, { dateStyle: "long" }) })}
      </p>
      <p className="leading-7">{t(document === "terms" ? "termsBody" : "privacyBody")}</p>
    </article>
  );
}
