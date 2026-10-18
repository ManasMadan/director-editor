/**
 * The shorts the fake YouTube knows. Each is a real, public YouTube video (so its picture
 * and the embedded player work), described as the kind of short Director is made for,
 * with the shot plan the fake Gemini writes for it (./plans.ts). Mock data: the titles,
 * counts and plans are made up; the videos are only stand-ins. The first is the exception,
 * the GRWM the demo recreates: its own title and channel, and a plan from its own cuts
 * (its counts are still made up).
 */
export type Template = "grwm" | "office-grwm" | "pen-drop" | "tree-talk";

export interface CatalogShort {
  videoId: string;
  title: string;
  channelTitle: string;
  durationSeconds: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  publishedAt: string;
  template: Template;
}

export const CATALOG: readonly CatalogShort[] = [
  {
    videoId: "HasaZYkwYds",
    title: "GRWM for the office in summer time!",
    channelTitle: "Adam Gonon",
    durationSeconds: 26,
    viewCount: 1_840_000,
    likeCount: 92_000,
    commentCount: 1_204,
    publishedAt: "2026-09-12T15:00:00Z",
    template: "office-grwm",
  },
  {
    videoId: "kJQP7kiw5Fk",
    title: "Dropped my pen… had to check the kicks",
    channelTitle: "Director demo",
    durationSeconds: 14,
    viewCount: 3_210_000,
    likeCount: 240_000,
    commentCount: 3_890,
    publishedAt: "2026-09-20T18:30:00Z",
    template: "pen-drop",
  },
  {
    videoId: "9bZkp7q19f0",
    title: "One tip that changed my mornings",
    channelTitle: "Director demo",
    durationSeconds: 24,
    viewCount: 760_000,
    likeCount: 41_000,
    commentCount: 512,
    publishedAt: "2026-09-25T08:10:00Z",
    template: "tree-talk",
  },
  {
    videoId: "OPf0YbXqDm0",
    title: "Get ready with me: date night",
    channelTitle: "Director demo",
    durationSeconds: 21,
    viewCount: 980_000,
    likeCount: 66_000,
    commentCount: 845,
    publishedAt: "2026-10-01T19:45:00Z",
    template: "grwm",
  },
  {
    videoId: "JGwWNGJdvx8",
    title: "Shoe check in 10 seconds",
    channelTitle: "Director demo",
    durationSeconds: 10,
    viewCount: 1_120_000,
    likeCount: 88_000,
    commentCount: 970,
    publishedAt: "2026-10-03T12:00:00Z",
    template: "pen-drop",
  },
  {
    videoId: "fJ9rUzIMcZQ",
    title: "Standing by my favourite tree: a story",
    channelTitle: "Director demo",
    durationSeconds: 28,
    viewCount: 430_000,
    likeCount: 25_000,
    commentCount: 301,
    publishedAt: "2026-10-05T07:20:00Z",
    template: "tree-talk",
  },
];

/**
 * The short with `videoId`: one of the catalog's, or, for any other well-formed id (a
 * pasted link), a generic one, so every link opens and gets a plan.
 */
export function shortOf(videoId: string): CatalogShort {
  return (
    CATALOG.find((short) => short.videoId === videoId) ?? {
      videoId,
      title: "Your pasted short",
      channelTitle: "Director demo",
      durationSeconds: 24,
      viewCount: 12_000,
      likeCount: 800,
      commentCount: 40,
      publishedAt: "2026-10-08T10:00:00Z",
      template: "tree-talk",
    }
  );
}
