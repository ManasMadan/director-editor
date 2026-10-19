import en from "@repo/i18n/messages/en.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { renderHtml, request } from "../../../../test/next-server";
import { LEGAL_CONTACT, LEGAL_SECTIONS, LegalPage } from "./legal";

const documents = [
  ["privacy", en.legal.privacy, en.legal.privacyDoc],
  ["terms", en.legal.terms, en.legal.termsDoc],
] as const;

// React escapes these in text.
const escaped = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;");

describe.each(documents)("the %s page", (document, title, doc) => {
  const render = async () => renderHtml(await LegalPage({ document }));

  it("is the real text, not the template's placeholder", async () => {
    const html = await render();
    expect(html).toContain(`<h1 class="text-3xl font-semibold tracking-tight">${title}</h1>`);
    expect(html).not.toMatch(/replace this text|before launch|lorem ipsum/i);
    // Every tag in the copy became an element: none is left over as text.
    expect(html).not.toContain("&lt;");
    expect(html.length).toBeGreaterThan(4000);
  });

  it("opens with the demo notice, before anything else is said", async () => {
    const html = await render();
    const notice = html.indexOf('role="note"');
    expect(notice).toBeGreaterThan(html.indexOf("</h1>"));
    expect(notice).toBeLessThan(html.indexOf("On this page"));
    expect(html.slice(notice)).toMatch(
      /^role="note"[^>]*><p><strong[^>]*>Director is an experimental demo built for a hackathon\.<\/strong>/,
    );
    expect(html).toContain("&quot;as is&quot; and &quot;as available&quot;");
    expect(html).toContain("shut down without notice");
  });

  it("promises nothing the demo can't keep", async () => {
    const html = await render();
    for (const promise of [
      /within 30 days/,
      /we&#x27;ll (tell|send|delete|answer|say)/i,
      /US dollars/,
      /before it takes effect/,
      /where we can/,
    ]) {
      expect(html).not.toMatch(promise);
    }
  });

  it("renders every section of the catalog, in order, with a contents entry linking to it", async () => {
    // Nothing in the catalog is left out of the page, and nothing on it is missing there.
    expect([...LEGAL_SECTIONS[document]]).toEqual(Object.keys(doc.sections));
    const html = await render();
    let last = html.indexOf("On this page");
    for (const [id, section] of Object.entries(doc.sections)) {
      const heading = escaped(section.title);
      expect(html).toContain(`href="#${id}"`);
      const at = html.indexOf(`<h2 id="${id}"`);
      expect(at).toBeGreaterThan(last);
      expect(html.slice(at, at + 200)).toContain(heading);
      last = at;
    }
  });

  it("gives a way to reach us", async () => {
    const html = await render();
    expect(html).toContain(`href="mailto:${LEGAL_CONTACT}"`);
    expect(html).toContain(`>${LEGAL_CONTACT}</a>`);
  });

  it("dates the text the same day wherever the reader is", async () => {
    for (const tz of ["Pacific/Honolulu", "Pacific/Kiritimati"]) {
      request.cookies.set("tz", tz);
      expect(await render()).toContain("Last updated October 19, 2026");
    }
  });
});

describe("what the pages say", () => {
  it("says what's recorded, where it goes and for how long", async () => {
    const html = await renderHtml(await LegalPage({ document: "privacy" }));
    for (const fact of [
      "Gemini Live",
      "us-central1",
      "ten-second pieces",
      "deleted 7 days",
      "never more than 14 days",
      "15 days after it was uploaded",
      "BigQuery&#x27;s US multi-region",
      "24 hours",
      "90 days",
      "BigQuery",
      "Cloudflare",
      "Resend",
      "Pexels and Pixabay",
    ]) {
      expect(html).toContain(fact);
    }
    expect(html).toContain('href="https://policies.google.com/privacy"');
    expect(html).toContain('href="https://security.google.com/settings/security/permissions"');
  });

  it("covers the original Shorts, AI output and YouTube's synthetic-content label", async () => {
    const html = await renderHtml(await LegalPage({ document: "terms" }));
    expect(html).toContain("altered or synthetic content");
    expect(html).toContain("a credit to the original creator");
    expect(html).toContain("experimental demo built for a hackathon");
    expect(html).toContain("To the fullest extent permitted by law");
    expect(html).toContain("at least 13");
    expect(html).toContain("You keep ownership of it.");
    expect(html).toContain('href="https://www.youtube.com/t/terms"');
    expect(html).toContain('href="/privacy"');
  });
});
