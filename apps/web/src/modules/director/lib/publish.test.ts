import { describe, expect, it } from "vitest";
import { hashtagsOf, hashtagsText, youtubeShortUrl } from "./publish";

describe("the hashtags field", () => {
  it("takes words however they're typed, without their # and once each", () => {
    expect(hashtagsOf(" #grwm, fitcheck  ##ootd grwm ")).toEqual(["grwm", "fitcheck", "ootd"]);
    expect(hashtagsOf("")).toEqual([]);
  });

  it("shows them with their #", () => {
    expect(hashtagsText(["grwm", "ootd"])).toBe("#grwm #ootd");
  });
});

it("links to a published video on YouTube", () => {
  expect(youtubeShortUrl("AbCdEfGhIjK")).toBe("https://youtube.com/shorts/AbCdEfGhIjK");
});
