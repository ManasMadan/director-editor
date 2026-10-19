/**
 * Reading a YouTube link someone pasted, shared by the API (which indexes it) and the web
 * (which checks it before sending it, so a word or another site's link is answered at
 * once, in its own words, rather than as a video YouTube doesn't have). Read with a
 * pattern rather than the URL global, which contracts' environment-free types don't have.
 */
import { type VideoId, videoIdSchema } from "./ids";

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

/** A link, with or without its scheme: its host, its path, and its query. */
const LINK = /^(?:https?:\/\/)?([^/?#\s]+)(\/[^?#\s]*)?(\?[^#\s]*)?(?:#\S*)?$/i;

/** The video id a youtube.com or youtu.be link names, by where that link puts it. */
function candidateOf(host: string, path: string, query: string): string | undefined {
  const [first, second] = path.split("/").filter(Boolean);
  if (host === "youtu.be") {
    return first;
  }
  if (!YOUTUBE_HOSTS.has(host)) {
    return undefined;
  }
  if (first === "shorts" || first === "embed") {
    return second;
  }
  return /[?&]v=([^&]*)/.exec(query)?.[1];
}

/**
 * The video id in a link someone pasted: youtube.com/shorts/<id>, youtube.com/watch?v=<id>,
 * youtu.be/<id>, or the bare id. Null for anything else.
 */
export function videoIdFromLink(link: string): VideoId | null {
  const trimmed = link.trim();
  const bare = videoIdSchema.safeParse(trimmed);
  if (bare.success) {
    return bare.data;
  }
  const parts = LINK.exec(trimmed);
  if (!parts) {
    return null;
  }
  const [, host = "", path = "", query = ""] = parts;
  const parsed = videoIdSchema.safeParse(candidateOf(host.toLowerCase(), path, query));
  return parsed.success ? parsed.data : null;
}
