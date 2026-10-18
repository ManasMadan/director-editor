import { describe, expect, it } from "vitest";
import { renderHtml } from "../../../../test/next-server";
import { SEED_TEMPLATES, XRAY } from "../lib/seed-excerpt";
import { HomePage } from "./home";

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
    for (const { videoId } of SEED_TEMPLATES) {
      expect(html).toContain(`href="/director/${videoId}"`);
    }
  });

  it("shows the 6 seed templates with YouTube's own thumbnails and their creators", async () => {
    const html = await renderHtml(await HomePage({ signedIn: false }));
    for (const { videoId, channel } of SEED_TEMPLATES) {
      expect(html).toContain(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);
      expect(html).toContain(`by ${channel.replaceAll("'", "&#x27;")}`);
    }
  });

  it("x-rays a seed with the plan Gemini wrote for it", async () => {
    const html = await renderHtml(await HomePage({ signedIn: false }));
    const [first] = XRAY.plan.shots;
    expect(first).toBeDefined();
    expect(html).toContain(XRAY.plan.title);
    // The phone shows the first shot's guides and lines, and the panel the JSON behind them.
    expect(html).toContain(first?.script[0]?.text.replaceAll("'", "&#x27;"));
    expect(html).toContain("&quot;shotSize&quot;");
    // Every shot is listed, timed to the original.
    for (const shot of XRAY.plan.shots) {
      expect(html).toContain(shot.title.replaceAll("&", "&amp;"));
    }
    expect(html).toContain("Built on Google Cloud");
  });
});
