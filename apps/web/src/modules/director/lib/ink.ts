/** The theme's colours (packages/ui theme.css) as a canvas draws them, read from the page. */
import type { CaptionInk } from "./caption-draw";

export function token(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Captions' colours: white words, a dark outline and box, YouTube's red on the word said. */
export function captionInk(): CaptionInk {
  return {
    text: token("--studio-foreground"),
    outline: token("--studio"),
    highlight: token("--record"),
    box: token("--studio"),
  };
}
