/**
 * The finished video's size and bitrates, and the error a render that came out short
 * ends in, apart from the code that renders it (lib/stitch.ts): the editor checks a
 * video's length against them as it opens, and loads the renderer only when the member
 * saves.
 */
import { uploadPurposes } from "@repo/contracts/files";

export const OUTPUT_WIDTH = 720;
export const OUTPUT_HEIGHT = 1280;
/**
 * About 4 Mbit/s of picture and 128 kbit/s of sound, for 720×1280 with captions: a
 * 3-minute Short comes to about 93 MB, inside a saved video's 100 MB upload (the virus
 * scanner's stream limit). Raising either means raising that limit with it.
 */
export const VIDEO_BITS_PER_SECOND = 4_000_000;
export const AUDIO_BITS_PER_SECOND = 128_000;
/** The longest video that fits a saved video's upload at those rates. */
export const MAX_SECONDS =
  (uploadPurposes["director-cut-video"].maxBytes * 8) /
  (VIDEO_BITS_PER_SECOND + AUDIO_BITS_PER_SECOND);

/**
 * The recording came out with less picture than the edit: the encoder fell too far
 * behind (a busy device), and what it hadn't encoded was lost. Not a video to save.
 */
export class IncompleteRender extends Error {
  override name = "IncompleteRender";
}
