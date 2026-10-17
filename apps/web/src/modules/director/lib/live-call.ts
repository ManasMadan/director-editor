/**
 * The video call with Director, as the browser sees it: where it connects (the API's
 * /api/live, on the page's own origin like /rpc), what the API sends down it, and the
 * captions built from both sides' transcripts. The messages mirror the API's relay
 * (apps/api/src/modules/live/live.messages.ts); what can't be read is ignored, the way
 * the relay ignores what it can't read from Gemini.
 */
import { errorCode } from "@repo/contracts/errors";
import * as z from "zod";

/** What Director can do to the camera app during a call. */
const LIVE_TOOLS = [
  "start_recording",
  "stop_recording",
  "next_shot",
  "previous_shot",
  "retake",
] as const;

const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("audio"), pcm16: z.base64() }),
  z.object({
    type: z.literal("transcript"),
    who: z.enum(["you", "director"]),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool"),
    name: z.enum(LIVE_TOOLS),
    args: z.object({ reason: z.string().optional() }),
  }),
  z.object({ type: z.literal("interrupted") }),
  // A code newer than this page is still a failure: our own, as far as it can tell.
  z.object({ type: z.literal("error"), code: errorCode.catch("INTERNAL") }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type LiveTool = (typeof LIVE_TOOLS)[number];
export type Speaker = "you" | "director";

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: the schema below refuses `undefined` like any other bad shape.
    return undefined;
  }
}

/** A frame from the call's socket, or null when it isn't a message this page knows. */
export function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== "string") {
    return null;
  }
  const parsed = serverMessageSchema.safeParse(parseJson(data));
  return parsed.success ? parsed.data : null;
}

/** The call's WebSocket URL for one shot of a short, on the page's origin. */
export function callUrl(
  page: Pick<Location, "protocol" | "host">,
  videoId: string,
  shotIndex: number,
): string {
  const scheme = page.protocol === "https:" ? "wss" : "ws";
  const query = new URLSearchParams({ videoId, shot: String(shotIndex) });
  return `${scheme}://${page.host}/api/live?${query}`;
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
