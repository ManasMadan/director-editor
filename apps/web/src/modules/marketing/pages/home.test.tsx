import { directorSeeds } from "@repo/contracts/director-seeds";
import { describe, expect, it } from "vitest";
import { renderHtml } from "../../../../test/next-server";
import { XRAY } from "../lib/seeds";
import { HomePage } from "./home";

// React escapes these in text; the seeds' titles and lines contain them.
const escaped = (text: string) => text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;");

describe("the landing page", () => {
  it("sends visitors straight into the demo, no sign-up", async () => {
    const html = await renderHtml(await HomePage({ signedIn: false }));
    expect(html).toContain("Watch any Short.");
    expect(html).toContain("A friend on your phone helps you film it, shot by shot.");
    expect(html).toContain('href="/sign-in?demo=1"');
    expect(html).toContain("Try it now, no sign-up");
    expect(html).not.toContain("Open Director");
    expect(html).not.toContain("Director-editor");
    // Each template opens in the demo once the browser is in.
    for (const { videoId } of directorSeeds) {
      expect(html).toContain(`href="/sign-in?demo=1&amp;next=%2Fdirector%2F${videoId}"`);
    }
  });

  it("shows a conversation with Director, the shot card changing, not a diagram", async () => {
    const html = await renderHtml(await HomePage({ signedIn: false }));
    for (const line of [
      "Let&#x27;s start at the market. Ready when you are!",
      "I&#x27;m fine inside",
      "Inside it is! Your window light looks great.",
      "Where: the market",
      "Where: by your window",
      "REC 01:12",
    ]) {
      expect(html).toContain(line);
    }
    // Who says what, for screen readers, in the order it's said.
    expect(html.indexOf("Director:")).toBeLessThan(html.indexOf("You:"));
    // A loop that never stops gets a way to stop it.
    expect(html).toContain("Pause the conversation");
    expect(html).toContain('aria-pressed="false"');
    // The shot card it changes comes after the exchange that changes it.
    expect(html.indexOf("Inside it is!")).toBeLessThan(html.indexOf("Where: by your window"));
    // Nothing of the live call the shoot no longer has.
    expect(html).not.toMatch(/live call|on a call/);
  });

  it("walks through the three steps: pick, shoot with Director, post", async () => {
    const html = await renderHtml(await HomePage({ signedIn: false }));
    for (const step of ["Pick a Short", "Shoot it with Director", "Post it to YouTube Shorts"]) {
      expect(html).toContain(step);
    }
  });

  it("sends members straight into Director and its templates", async () => {
    const html = await renderHtml(await HomePage({ signedIn: true }));
    expect(html).toContain('href="/library"');
    expect(html).toContain("Open Director");
    expect(html).not.toContain("Try it now");
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
    expect(html).toContain("How Director reads a Short");
  });

  it("names only what Director records in BigQuery", async () => {
    const html = await renderHtml(await HomePage({ signedIn: false }));
    expect(html).toContain("Built on Google Cloud");
    expect(html).toContain(
      "Logs each Short Director indexes, each shoot it directs and every take review&#x27;s score.",
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
      ["Compute Engine", "Runs Director&#x27;s API, its line to Gemini Live and the job queues."],
    ]) {
      expect(html).toContain(name);
      expect(html).toContain(use);
    }
  });
});
