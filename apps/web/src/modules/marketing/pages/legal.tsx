import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

// Bump when either document's text changes; shown to readers as "Last updated".
const LAST_UPDATED = new Date("2026-10-19T00:00:00Z");

/** Where questions, requests and complaints about either document go. */
export const LEGAL_CONTACT = "manasmadan08@gmail.com";

/**
 * Each document's sections, in reading order. Their text is in packages/i18n under
 * `legal.<document>Doc.sections.<id>`; the id is also the heading's anchor, so a link to
 * /privacy#retention keeps working as the copy changes.
 */
export const LEGAL_SECTIONS = {
  privacy: [
    "summary",
    "account",
    "demo",
    "shoot",
    "content",
    "youtube",
    "analytics",
    "sharing",
    "location",
    "retention",
    "rights",
    "cookies",
    "security",
    "children",
    "changes",
    "contact",
  ],
  terms: [
    "status",
    "using",
    "account",
    "rules",
    "content",
    "templates",
    "ai",
    "youtube",
    "ours",
    "ending",
    "warranty",
    "liability",
    "changes",
    "contact",
  ],
} as const;

type LegalDocument = keyof typeof LEGAL_SECTIONS;

const link = "font-medium underline underline-offset-4 hover:text-primary";

const external = (href: string) => (chunks: ReactNode) => (
  <a href={href} className={link} rel="noreferrer">
    {chunks}
  </a>
);

/**
 * The markup the documents' messages may use. Every message gets them all; the links'
 * addresses live here rather than in the copy, so a translation can't send a reader
 * somewhere else.
 */
const markup = {
  p: (chunks: ReactNode) => <p>{chunks}</p>,
  ul: (chunks: ReactNode) => <ul className="flex list-disc flex-col gap-2 pl-6">{chunks}</ul>,
  li: (chunks: ReactNode) => <li>{chunks}</li>,
  b: (chunks: ReactNode) => <strong className="font-semibold">{chunks}</strong>,
  mail: (chunks: ReactNode) => (
    <a href={`mailto:${LEGAL_CONTACT}`} className={link}>
      {chunks}
    </a>
  ),
  privacy: (chunks: ReactNode) => (
    <Link href="/privacy" className={link}>
      {chunks}
    </Link>
  ),
  ytTerms: external("https://www.youtube.com/t/terms"),
  googlePrivacy: external("https://policies.google.com/privacy"),
  googlePermissions: external("https://security.google.com/settings/security/permissions"),
};

interface Section {
  id: string;
  title: string;
  body: ReactNode;
}

/** A document's introduction and sections, translated. */
async function translated(
  document: LegalDocument,
): Promise<{ intro: ReactNode; sections: Section[] }> {
  const t = await getTranslations("legal");
  // One branch per document, so each key is checked against its own document's sections.
  if (document === "privacy") {
    return {
      intro: t.rich("privacyDoc.intro", markup),
      sections: LEGAL_SECTIONS.privacy.map((id) => ({
        id,
        title: t(`privacyDoc.sections.${id}.title`),
        body: t.rich(`privacyDoc.sections.${id}.body`, markup),
      })),
    };
  }
  return {
    intro: t.rich("termsDoc.intro", markup),
    sections: LEGAL_SECTIONS.terms.map((id) => ({
      id,
      title: t(`termsDoc.sections.${id}.title`),
      body: t.rich(`termsDoc.sections.${id}.body`, markup),
    })),
  };
}

/** Terms and privacy. The copy lives in packages/i18n (`legal.*`) like every other text. */
export async function LegalPage({ document }: { document: LegalDocument }) {
  const [t, format, { intro, sections }] = await Promise.all([
    getTranslations("legal"),
    getFormatter(),
    translated(document),
  ]);
  return (
    <article className="flex max-w-2xl flex-col gap-8 leading-7">
      <header className="flex flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">{t(document)}</h1>
        <p className="text-sm text-muted-foreground">
          {t("lastUpdated", {
            // A calendar date: the same day wherever the reader is.
            date: format.dateTime(LAST_UPDATED, { dateStyle: "long", timeZone: "UTC" }),
          })}
        </p>
        {/* Both documents open with what Director is: a demo, with no promises. */}
        <div role="note" className="rounded-lg border border-destructive/50 bg-muted p-4">
          {t.rich("demoNotice", markup)}
        </div>
        <div className="flex flex-col gap-3">{intro}</div>
      </header>
      <nav aria-labelledby="contents" className="rounded-lg border p-4">
        <h2 id="contents" className="font-semibold">
          {t("contents")}
        </h2>
        <ol className="mt-2 flex list-decimal flex-col gap-1 pl-6">
          {sections.map(({ id, title }) => (
            <li key={id}>
              <a href={`#${id}`} className={link}>
                {title}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      {sections.map(({ id, title, body }) => (
        <section key={id} aria-labelledby={id} className="flex flex-col gap-3">
          <h2 id={id} className="scroll-mt-20 text-xl font-semibold tracking-tight">
            {title}
          </h2>
          {body}
        </section>
      ))}
    </article>
  );
}
