import { describe, expect, it } from "vitest";
import { videoIdFromLink } from "./youtube-link";

describe("a pasted link", () => {
  it.each([
    ["dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["  https://www.youtube.com/shorts/dQw4w9WgXcQ  ", "dQw4w9WgXcQ"],
    ["HTTPS://M.YOUTUBE.COM/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["youtube.com/watch?v=dQw4w9WgXcQ&t=10", "dQw4w9WgXcQ"],
    ["http://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"],
    // What the share sheet on a phone gives: a query and sometimes a fragment.
    ["https://youtube.com/shorts/dQw4w9WgXcQ?si=Ab1-cD&feature=share", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ/", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ#t=5", "dQw4w9WgXcQ"],
    ["youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ])("finds the video in %s", (link, expected) => {
    expect(videoIdFromLink(link)).toBe(expected);
  });

  it.each([
    [""],
    ["   "],
    ["not a link at all"],
    ["https://example.com/watch?v=dQw4w9WgXcQ"],
    ["https://example.com/shorts/dQw4w9WgXcQ"],
    ["https://www.youtube.com.example.com/shorts/dQw4w9WgXcQ"],
    ["https://www.youtube.com/"],
    ["https://www.youtube.com/watch"],
    ["https://www.youtube.com/watch?xv=dQw4w9WgXcQ"],
    ["https://www.youtube.com/channel/dQw4w9WgXcQ"],
    ["https://youtu.be/"],
    ["https://www.youtube.com/shorts/too-short"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ extra"],
    ["ftp://youtube.com/shorts/dQw4w9WgXcQ"],
  ])("finds nothing in %j", (link) => {
    expect(videoIdFromLink(link)).toBeNull();
  });
});
