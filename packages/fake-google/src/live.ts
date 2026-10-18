/**
 * A stand-in for Gemini's Live API on Vertex AI (BidiGenerateContent, JSON over a
 * WebSocket) at the path Vertex serves it, so the API's relay and the web app's shoot
 * screen run with Director live on in tests, as production does. Like the real one it
 * checks the bearer token, wants a `setup` first and answers it with `setupComplete`, and
 * hands out session resumption handles that a later connection can resume from.
 *
 * What it says is scripted: each complete text turn gets a short spoken answer (a
 * transcript and a moment of silent audio), the app's own notes in square brackets get
 * a line about what they say (a quiet nudge, the first and the second), and a note it
 * should only know gets no answer. It keeps the shot it was briefed on, from the setup's
 * system instruction and each move's brief: "say my line" reads that shot's line, the
 * member's own when they changed it. A member's turn that names a tool's cue gets that
 * tool call: "go to shot 2" calls go_to_shot, "switch to the back camera" calls
 * switch_camera, "what if I do it with my grandma" gets a word about it and then
 * adapt_shot, "I'm switching indoors" and "one angle is fine" remember and replan, and
 * "skip this one" calls skip_shot; while the roll records, "here goes" marks an
 * attempt's start and "how was that" its end. Once a tool's answer comes back it says
 * whether it worked (and nothing after a start mark: it's quiet while the member goes).
 * Microphone audio and camera frames are only counted. `goAway()` warns every open connection that it's
 * about to close, as Vertex does before its ten-minute limit.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import * as z from "zod";

export const LIVE_API_PATH = "/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent";

/** A tenth of a second of 24 kHz 16-bit silence: something for the browser to play. */
const SILENCE = Buffer.alloc(4800).toString("base64");

const clientMessage = z.object({
  setup: z
    .object({
      model: z.string(),
      systemInstruction: z.object({ parts: z.array(z.object({ text: z.string() })) }).optional(),
      sessionResumption: z.object({ handle: z.string().optional() }).optional(),
    })
    .optional(),
  clientContent: z
    .object({
      turns: z.array(z.object({ parts: z.array(z.object({ text: z.string() })) })),
      turnComplete: z.boolean().optional(),
    })
    .optional(),
  realtimeInput: z
    .object({ audio: z.object({}).optional(), video: z.object({}).optional() })
    .optional(),
  toolResponse: z
    .object({
      functionResponses: z.array(
        z.object({ id: z.string().optional(), name: z.string(), response: z.unknown() }),
      ),
    })
    .optional(),
});

/** One connection, as a test inspects it. */
interface LiveSession {
  model: string;
  /** The handle this connection resumed from, if it did. */
  resumedFrom: string | null;
  /** Every text turn it was sent, in order (the app's notes and what the member typed). */
  turns: string[];
  audioChunks: number;
  frames: number;
  /** What came of each tool call it made. */
  toolResponses: unknown[];
  open: boolean;
}

/** What Director says to one of the app's notes, by what the note is about. */
const NOTE_ANSWERS: [RegExp, (match: RegExpExecArray) => string][] = [
  [/^\[They just tapped Start shooting/, () => "Hey! I'm Director. How much time have you got?"],
  [/^\[They flipped to the back camera/, () => "Ooh, the back camera! Now I can see the room."],
  [/^\[They flipped to the front/, () => "And we're back on you!"],
  [/^\[They've moved on to shot (\d+)/, (match) => `Shot ${match[1]}! Let's do it.`],
  [/^\[The take just ended/, () => "Nice one! Maybe hold the last moment a beat longer."],
  [/^\[They called the countdown off/, () => "All good? Go whenever you're ready."],
  [/^\[They've been quiet for/, () => "Want to give it a go?"],
  [/^\[They've been quiet again/, () => "I'll wait. Just say when."],
];

/**
 * The line of the shot a brief describes: the member's own, if they changed it, or the
 * script's lines together.
 */
function lineIn(brief: string): string | null {
  const theirs = [...brief.matchAll(/^- Their line: "(.*)"$/gm)].at(-1);
  if (theirs) {
    // Quoted as JSON in the brief.
    return z.string().parse(JSON.parse(`"${theirs[1]}"`));
  }
  const script = [...brief.matchAll(/^- \d+(?:\.\d+)?s to \d+(?:\.\d+)?s: "(.*)"$/gm)];
  return script.length > 0 ? script.map((line) => line[1]).join(" ") : null;
}

function answerTo(text: string): string {
  for (const [pattern, answer] of NOTE_ANSWERS) {
    const match = pattern.exec(text);
    if (match) {
      return answer(match);
    }
  }
  return text.startsWith("[") ? "Okay!" : `You said: ${text}`;
}

type ToolCall = { name: string; args: object };

/**
 * The constraints Director remembers and re-plans by, said once: indoors and one angle
 * hold for every shot that's left; "skip this one" leaves the shot out.
 */
function versionCallsFor(text: string, shot: number): ToolCall[] {
  if (
    /\b(?:switching indoors|inside only|(?:fine|happy) (?:shooting |filming )?inside)\b/i.test(text)
  ) {
    return [
      { name: "remember", args: { kind: "place", note: "Indoors" } },
      { name: "replan", args: { instruction: "film every shot indoors" } },
    ];
  }
  if (/\bone angle\b/i.test(text)) {
    return [
      { name: "remember", args: { kind: "angles", note: "One angle" } },
      { name: "replan", args: { instruction: "one position, front camera" } },
    ];
  }
  if (/\bskip this one\b/i.test(text)) {
    return [{ name: "skip_shot", args: { shot } }];
  }
  return [];
}

/** The tool calls a member's turn asks for, if it names any; `shot` is the one it's on, from 1. */
function toolCallsFor(text: string, shot: number): ToolCall[] {
  const versionCalls = versionCallsFor(text, shot);
  return versionCalls.length > 0
    ? versionCalls
    : [toolCallFor(text, shot)].filter((call) => call !== null);
}

/** The one tool call a member's turn asks for, if it names one. */
function toolCallFor(text: string, shot: number): ToolCall | null {
  if (/\bhere goes\b/i.test(text)) {
    return { name: "mark", args: { event: "start" } };
  }
  if (/\bhow was that\b/i.test(text)) {
    return { name: "mark", args: { event: "end", note: "Clear and confident" } };
  }
  const twist = /\bwhat if I (?:do (?:it|this one) )?with my (\w+)/i.exec(text);
  if (twist) {
    return {
      name: "adapt_shot",
      args: { shot, action: `You and your ${twist[1]} do it together` },
    };
  }
  const another = /\bgo to shot (\d+)\b/i.exec(text);
  if (another) {
    return { name: "go_to_shot", args: { shot: Number(another[1]) } };
  }
  const camera = /\b(?:switch|flip) to the (front|back) camera\b/i.exec(text);
  if (camera) {
    return { name: "switch_camera", args: { to: camera[1]?.toLowerCase() } };
  }
  return null;
}

function send(socket: WebSocket, message: object) {
  socket.send(JSON.stringify(message));
}

/** Director says `text`: a moment of sound, then its words, and its turn is over. */
function say(socket: WebSocket, text: string) {
  send(socket, {
    serverContent: {
      modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: SILENCE } }] },
    },
  });
  send(socket, { serverContent: { outputTranscription: { text }, turnComplete: true } });
}

function parse(data: RawData) {
  try {
    return clientMessage.safeParse(JSON.parse(String(data)));
  } catch {
    return null;
  }
}

type ClientMessage = z.infer<typeof clientMessage>;

/** Counters shared by every connection, so handles and tool calls never repeat an id. */
interface Ids {
  handles: number;
  toolCalls: number;
}

/** One connection, past its setup: counted, answered, tool calls made on their cues. */
class Conversation {
  /** Start marks not answered yet: once they are, it stays quiet. */
  private readonly starts = new Set<string>();

  constructor(
    private readonly socket: WebSocket,
    private readonly session: LiveSession,
    private readonly resumable: boolean,
    private readonly ids: Ids,
    /** The shot it was last briefed on, as the app described it. */
    private brief: string,
  ) {
    this.handOver();
    socket.on("message", (data) => {
      const message = parse(data);
      if (!message?.success) {
        return socket.close(1007, "Request contains an invalid argument.");
      }
      this.hear(message.data);
    });
  }

  /** A handle to resume from, after each turn, when the setup asked for them. */
  private handOver() {
    if (this.resumable) {
      this.ids.handles += 1;
      const newHandle = `fake-handle-${this.ids.handles}`;
      send(this.socket, { sessionResumptionUpdate: { newHandle, resumable: true } });
    }
  }

  private hear({ clientContent, realtimeInput, toolResponse }: ClientMessage) {
    this.session.audioChunks += realtimeInput?.audio ? 1 : 0;
    this.session.frames += realtimeInput?.video ? 1 : 0;
    for (const answer of toolResponse?.functionResponses ?? []) {
      this.session.toolResponses.push(answer.response);
      const done = z.object({ result: z.literal("done") }).safeParse(answer.response).success;
      const started = answer.id !== undefined && this.starts.delete(answer.id);
      if (!(done && started)) {
        say(this.socket, done ? "There you go." : "Let's finish this one first.");
      }
    }
    if (clientContent) {
      this.turn(clientContent);
    }
  }

  private turn(content: NonNullable<ClientMessage["clientContent"]>) {
    const text = content.turns.flatMap((turn) => turn.parts.map((part) => part.text)).join("\n");
    this.session.turns.push(text);
    this.learn(text);
    if (!content.turnComplete) {
      return;
    }
    const tools = toolCallsFor(text, this.shot());
    if (tools.length > 0) {
      if (tools[0]?.name === "adapt_shot") {
        say(this.socket, "Ooh, I love that. Let's put it on your card.");
      }
      const functionCalls = tools.map((tool) => {
        this.ids.toolCalls += 1;
        const id = `call-${this.ids.toolCalls}`;
        if (tool.name === "mark" && "event" in tool.args && tool.args.event === "start") {
          this.starts.add(id);
        }
        return { id, ...tool };
      });
      send(this.socket, { toolCall: { functionCalls } });
    } else if (/\bmy line\b/i.test(text)) {
      const line = lineIn(this.brief);
      say(this.socket, line ? `It's: "${line}"` : "No line in this one, just the moves.");
    } else {
      say(this.socket, answerTo(text));
    }
    this.handOver();
  }

  /** A move to another shot briefs it afresh; the member's version adds to the brief. */
  private learn(text: string) {
    if (text.includes("<shot>")) {
      this.brief = text;
    } else if (text.startsWith("[Their version of this shot")) {
      this.brief += `\n${text.slice(1, -1)}`;
    }
  }

  /** The shot it's on, from 1. */
  private shot(): number {
    return Number(/\bShot (\d+) of \d+/.exec(this.brief)?.[1] ?? 1);
  }
}

export function createLive({ accessToken }: { accessToken: string }) {
  const server = new WebSocketServer({ noServer: true });
  const sessions: LiveSession[] = [];
  const sockets = new Set<WebSocket>();
  const ids: Ids = { handles: 0, toolCalls: 0 };

  server.on("connection", (socket: WebSocket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("message", (data) => {
      const setup = parse(data)?.data?.setup;
      if (!setup) {
        // The real one refuses a connection that doesn't start with its setup.
        return socket.close(1007, "Request contains an invalid argument.");
      }
      const session: LiveSession = {
        model: setup.model,
        resumedFrom: setup.sessionResumption?.handle ?? null,
        turns: [],
        audioChunks: 0,
        frames: 0,
        toolResponses: [],
        open: true,
      };
      sessions.push(session);
      socket.on("close", () => {
        session.open = false;
      });
      send(socket, { setupComplete: {} });
      const brief = setup.systemInstruction?.parts.map((part) => part.text).join("\n") ?? "";
      new Conversation(socket, session, setup.sessionResumption !== undefined, ids, brief);
    });
  });

  return {
    sessions,
    /** Takes the upgrade if it's the Live API's path; false leaves it to someone else. */
    upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, path: string): boolean {
      if (path !== LIVE_API_PATH) {
        return false;
      }
      if (request.headers.authorization !== `Bearer ${accessToken}`) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return true;
      }
      server.handleUpgrade(request, socket, head, (client) => server.emit("connection", client));
      return true;
    },
    /** Warns every open connection that it closes soon, as Vertex does near its limit. */
    goAway() {
      for (const socket of sockets) {
        send(socket, { goAway: { timeLeft: "5s" } });
      }
    },
    close() {
      for (const socket of sockets) {
        socket.terminate();
      }
      server.close();
    },
  };
}
