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

export interface Caption {
  who: Speaker;
  text: string;
  /** Bumped for each new line, so the caption can animate even when the words repeat. */
  key: number;
  /** Finished: its speaker's turn is over (Director said so, or the other side spoke). */
  done: boolean;
}

/** The last exchange, oldest first: at most two lines, the newest at the bottom. */
export interface Captions {
  lines: Caption[];
  key: number;
}

export const NO_CAPTIONS: Captions = { lines: [], key: 0 };

/** A caption is read at a glance: past this, only its last words stay. */
const CAPTION_MAX_LENGTH = 160;
/** One exchange: what was said, and the answer to it. */
const LINES = 2;

function lastWords(text: string): string {
  if (text.length <= CAPTION_MAX_LENGTH) {
    return text;
  }
  const tail = text.slice(-(CAPTION_MAX_LENGTH - 1));
  return `…${tail.slice(tail.indexOf(" ") + 1)}`;
}

/** A new line from `who`: the one before it is finished, and only the last exchange stays. */
function newLine(captions: Captions, who: Speaker, text: string, done: boolean): Captions {
  const key = captions.key + 1;
  const earlier = captions.lines.map((line) => ({ ...line, done: true }));
  const line = { who, text: lastWords(text.trimStart()), key, done };
  return { lines: [...earlier, line].slice(-LINES), key };
}

/**
 * The captions once `who` has said `text`. Transcripts arrive a few words at a time, so
 * words carry on the last line while its speaker's turn goes on; a change of speaker, or
 * a finished line, starts a new one, under the one it answers.
 */
export function withTranscript(captions: Captions, who: Speaker, text: string): Captions {
  const last = captions.lines.at(-1);
  if (last && last.who === who && !last.done) {
    const lines = [...captions.lines.slice(0, -1), { ...last, text: lastWords(last.text + text) }];
    return { ...captions, lines };
  }
  return newLine(captions, who, text, false);
}

/** A line the member typed: finished as it's sent. */
export function withTyped(captions: Captions, text: string): Captions {
  return newLine(captions, "you", text, true);
}

/** Director's turn is over: its line is finished, and its next words start a new one. */
export function turnEnded(captions: Captions): Captions {
  return { ...captions, lines: captions.lines.map((line) => ({ ...line, done: true })) };
}

/** Without the member's line: answered a while ago, or overtaken by what they did. */
export function withoutMember(captions: Captions): Captions {
  const lines = captions.lines.filter((line) => line.who === "director");
  return lines.length === captions.lines.length ? captions : { ...captions, lines };
}

/** Whether the member's line has had its answer: Director's finished reply sits under it. */
export function answered({ lines }: Captions): boolean {
  const [first, second] = lines;
  return first?.who === "you" && second?.who === "director" && second.done;
}
