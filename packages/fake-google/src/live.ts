/**
 * A stand-in for Gemini's Live API on Vertex AI (BidiGenerateContent, JSON over a
 * WebSocket) at the path Vertex serves it, so the API's relay and the web app's shoot
 * screen run with Director live on in tests, as production does. Like the real one it
 * checks the bearer token, wants a `setup` first and answers it with `setupComplete`, and
 * hands out session resumption handles that a later connection can resume from.
 *
 * What it says is scripted: each complete text turn gets a short spoken answer (a
 * transcript and a moment of silent audio), the app's own notes in square brackets get
 * a line about what they say, and a member's turn that names a tool's cue gets that tool
 * call: "go to shot 2" calls go_to_shot, "switch to the back camera" calls switch_camera.
 * Once the tool's answer comes back it says whether it worked. Microphone audio and
 * camera frames are only counted. `goAway()` warns every open connection that it's
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
];

function answerTo(text: string): string {
  for (const [pattern, answer] of NOTE_ANSWERS) {
    const match = pattern.exec(text);
    if (match) {
      return answer(match);
    }
  }
  return text.startsWith("[") ? "Okay!" : `You said: ${text}`;
}

/** The tool call a member's turn asks for, if it names one. */
function toolCallFor(text: string): { name: string; args: object } | null {
  const shot = /\bgo to shot (\d+)\b/i.exec(text);
  if (shot) {
    return { name: "go_to_shot", args: { shot: Number(shot[1]) } };
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
  constructor(
    private readonly socket: WebSocket,
    private readonly session: LiveSession,
    private readonly resumable: boolean,
    private readonly ids: Ids,
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
      say(this.socket, done ? "There you go." : "Let's finish this one first.");
    }
    if (clientContent) {
      this.turn(clientContent);
    }
  }

  private turn(content: NonNullable<ClientMessage["clientContent"]>) {
    const text = content.turns.flatMap((turn) => turn.parts.map((part) => part.text)).join("\n");
    this.session.turns.push(text);
    if (!content.turnComplete) {
      return;
    }
    const tool = toolCallFor(text);
    if (tool) {
      this.ids.toolCalls += 1;
      const id = `call-${this.ids.toolCalls}`;
      send(this.socket, { toolCall: { functionCalls: [{ id, ...tool }] } });
    } else {
      say(this.socket, answerTo(text));
    }
    this.handOver();
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
      new Conversation(socket, session, setup.sessionResumption !== undefined, ids);
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
