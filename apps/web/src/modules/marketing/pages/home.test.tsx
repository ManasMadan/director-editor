import { directorSeeds } from "@repo/contracts/director-seeds";
import { describe, expect, it } from "vitest";
import { renderHtml } from "../../../../test/next-server";
import { XRAY } from "../lib/seeds";
import { HomePage } from "./home";

// React escapes these in text; the seeds' titles and lines contain them.
const escaped = (text: string) => text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;");

describe("the landing page", () => {
  it("sends visitors to the demo", async () => {
    const html = await renderHtml(await HomePage({ signedIn: false }));
    expect(html).toContain("Watch any Short.");
    expect(html).toContain('href="/sign-in?demo=1"');
    expect(html).toContain("Try the demo");
    expect(html).not.toContain("Open Director");
    expect(html).not.toContain("Director-editor");
  });

  it("sends members straight into Director and its templates", async () => {
    const html = await renderHtml(await HomePage({ signedIn: true }));
    expect(html).toContain('href="/library"');
    expect(html).toContain("Open Director");
    expect(html).not.toContain("Try the demo");
    for (const { videoId } of directorSeeds) {
      expect(html).toContain(`href="/director/${videoId}"`);
    }
  });

  it("shows the 6 shared seed templates with YouTube's own thumbnails", async () => {
    const html = await renderHtml(await HomePage({ signedIn: false }));
    for (const { videoId, plan } of directorSeeds) {
      expect(html).toContain(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);
      expect(html).toContain(escaped(plan.title));
    }
  });

  it("x-rays a seed with the plan Gemini wrote for it", async () => {
    const html = await renderHtml(await HomePage({ signedIn: false }));
    expect(html).toContain(escaped(XRAY.plan.title));
    // The phone shows the first shot's guides and lines, and the panel the JSON behind them.
    expect(html).toContain(escaped(XRAY.firstShot.script[0]?.text ?? ""));
    expect(html).toContain("&quot;shotSize&quot;");
    // Every shot is listed, timed to the original, beside it.
    for (const shot of XRAY.plan.shots) {
      expect(html).toContain(escaped(shot.title));
    }
    expect(html).toContain("This Short, and the shots Gemini found in it.");
  });

  it("names only what Director records in BigQuery", async () => {
    const html = await renderHtml(await HomePage({ signedIn: false }));
    expect(html).toContain("Built on Google Cloud");
    expect(html).toContain(
      "Logs each Short Director indexes, each shoot Director joins and every take review&#x27;s score.",
    );
    expect(html).not.toContain("every indexing");
  });

  it("lists every Google Cloud service Director runs on, with what each does here", async () => {
    const html = await renderHtml(await HomePage({ signedIn: false }));
    for (const [name, use] of [
      ["Gemini text-to-speech", "Gives Director its voice while you film."],
      ["Nano Banana on Vertex AI", "Drew the storyboard card of every shot in the templates."],
      ["Veo on Vertex AI", "Made the preview clip of every shot in the templates."],
      ["Lyria on Vertex AI", "Wrote each template&#x27;s soundtrack."],
      ["Cloud Run", "Runs the indexer, where Gemini watches each Short."],
    ]) {
      expect(html).toContain(name);
      expect(html).toContain(use);
    }
  });
});
