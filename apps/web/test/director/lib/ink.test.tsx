import { afterEach, describe, expect, it } from "vitest";
import { captionInk, token } from "@/modules/director/lib/ink";

const root = document.documentElement.style;

afterEach(() => {
  for (const name of ["--studio", "--studio-foreground", "--record"]) {
    root.removeProperty(name);
  }
});

describe("the theme's ink", () => {
  it("reads a colour from the page's theme, trimmed", () => {
    root.setProperty("--record", "  #ff0033 ");
    expect(token("--record")).toBe("#ff0033");
    expect(token("--not-a-token")).toBe("");
  });

  it("gives captions white words, a dark outline and box, and red on the word said", () => {
    root.setProperty("--studio-foreground", "#fafafa");
    root.setProperty("--studio", "#0a0a0a");
    root.setProperty("--record", "#ff0033");
    expect(captionInk()).toEqual({
      text: "#fafafa",
      outline: "#0a0a0a",
      highlight: "#ff0033",
      box: "#0a0a0a",
    });
  });
});
