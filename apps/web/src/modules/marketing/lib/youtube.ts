/**
 * YouTube's public thumbnails (i.ytimg.com, allowed by the CSP's `img-src https:`). A
 * Short's are 4:3 with the portrait frame in the middle, so a 9:16 box with `object-cover`
 * shows exactly the frame: `hqdefault` (360 px tall) for a grid, `sddefault` (480 px)
 * for the larger x-ray phone.
 */
export const thumbnailUrl = (videoId: string, size: "hqdefault" | "sddefault") =>
  `https://i.ytimg.com/vi/${videoId}/${size}.jpg`;
