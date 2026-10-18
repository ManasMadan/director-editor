/**
 * The publish sheet's hashtags field, typed as words: what the API takes is the words
 * without their #, once each.
 */

/** The hashtags someone typed ("#grwm, fitcheck"), as the API takes them. */
export function hashtagsOf(text: string): string[] {
  const words = text
    .split(/[\s,]+/)
    .map((word) => word.replace(/^#+/, ""))
    .filter(Boolean);
  return [...new Set(words)];
}

/** The hashtags as the field shows them. */
export const hashtagsText = (hashtags: string[]) => hashtags.map((tag) => `#${tag}`).join(" ");

/** Where a published video is on YouTube. */
export const youtubeShortUrl = (youtubeVideoId: string) =>
  `https://youtube.com/shorts/${youtubeVideoId}`;
