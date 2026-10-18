/**
 * Director live, as the browser sees it: where it connects (the API's live route, on the
 * page's own origin like /rpc), what the API sends down it (the shared schema in
 * @repo/contracts/live), and the captions built from both sides' transcripts. What can't
 * be read is ignored, the way the relay ignores what it can't read from Gemini.
 */
import { LIVE_PATH, type LiveServerMessage, liveServerMessage } from "@repo/contracts/live";

export type Speaker = "you" | "director";

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: the schema below refuses `undefined` like any other bad shape.
    return undefined;
  }
}

/** A frame from the socket, or null when it isn't a message this page knows. */
export function parseServerMessage(data: unknown): LiveServerMessage | null {
  if (typeof data !== "string") {
    return null;
  }
  const parsed = liveServerMessage.safeParse(parseJson(data));
  return parsed.success ? parsed.data : null;
}

/**
 * Director live's WebSocket URL for a short, starting on one of its shots, on the page's
 * origin. `resume`: Director was lost a moment ago and is coming straight back, so it
 * carries on without saying hello again.
 */
export function liveUrl(
  page: Pick<Location, "protocol" | "host">,
  videoId: string,
  shotIndex: number,
  resume = false,
): string {
  const scheme = page.protocol === "https:" ? "wss" : "ws";
  const query = new URLSearchParams({ videoId, shot: String(shotIndex) });
  if (resume) {
    query.set("resume", "1");
  }
  return `${scheme}://${page.host}${LIVE_PATH}?${query}`;
}

interface Caption {
  text: string;
  /** Bumped for each new line, so the caption can animate even when the words repeat. */
  key: number;
}

export interface Captions {
  you: Caption | null;
  director: Caption | null;
  /** Who spoke last: their next words carry on the same line. */
  last: Speaker | null;
  key: number;
}

export const NO_CAPTIONS: Captions = { you: null, director: null, last: null, key: 0 };

/** A caption is read at a glance: past this, only its last words stay. */
const CAPTION_MAX_LENGTH = 160;

function lastWords(text: string): string {
  if (text.length <= CAPTION_MAX_LENGTH) {
    return text;
  }
  const tail = text.slice(-(CAPTION_MAX_LENGTH - 1));
  return `…${tail.slice(tail.indexOf(" ") + 1)}`;
}

/**
 * The captions once `who` has said `text`. Transcripts arrive a few words at a time, so
 * words from whoever spoke last carry on their line, and a change of speaker starts a
 * new one; the other side's last line stays up until they speak again.
 */
export function withTranscript(captions: Captions, who: Speaker, text: string): Captions {
  const current = captions[who];
  if (captions.last === who && current) {
    return { ...captions, [who]: { ...current, text: lastWords(current.text + text) } };
  }
  const key = captions.key + 1;
  return { ...captions, [who]: { text: lastWords(text.trimStart()), key }, last: who, key };
}
