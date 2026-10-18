/**
 * Director live for one shoot: the browser's socket on one side, Gemini's Live API
 * (Vertex AI) on the other. The browser's microphone and camera go up as realtime input;
 * Gemini's voice, both sides' transcripts and its tool calls come back down. One socket
 * carries the whole shoot: a move to another shot is a turn telling Gemini about it, and
 * what the member does on screen (a flip of the camera, a take) becomes a note in the
 * app's own words.
 *
 * Gemini's connections last about ten minutes; a shoot runs longer. So the relay moves to
 * a fresh connection on its own, after `rotateAfterMs` or as soon as Gemini says the
 * current one is going away, and picks the conversation up there with the Live API's
 * session resumption (or, without a handle, with the last few lines said). The new
 * connection is ready before the old one is let go, so the member never notices.
 *
 * A tool call reaches the browser with an id; Gemini hears what really happened once the
 * browser answers it (done, or refused and why), not before. The shoot ends when either
 * side closes, Gemini fails, or it reaches its time limit; the browser hears why as an
 * `error` message just before its socket closes.
 */
import { DIRECTOR_MAX_SHOTS, type ShotPlan } from "@repo/contracts/api";
import { ERROR_CODES, type ErrorCode } from "@repo/contracts/errors";
import {
  LIVE_TOOLS,
  type LiveAdaptation,
  type LiveClientMessage,
  type LiveServerMessage,
  type LiveTool,
  type LiveToolCall,
  type LiveToolResult,
  liveAdaptation,
  liveClientMessage,
} from "@repo/contracts/live";
import { PROVIDER_TIMEOUT_MS, SECOND_MS } from "@repo/contracts/time";
import { describeError } from "@repo/nest-common";
import { type RawData, WebSocket } from "ws";
import type { GoogleAuth } from "./google-auth";
import { SlidingBudget } from "./live.budget";
import {
  toolArgsSchemas,
  UPSTREAM_MAX_PAYLOAD_BYTES,
  type UpstreamMessage,
  upstreamMessageSchema,
} from "./live.messages";
import { Pacer } from "./live.pacer";
import {
  cameraMessage,
  catchUpMessage,
  greetingMessage,
  noiseMessage,
  quietMessage,
  resumedMessage,
  shotMessage,
  takeMessage,
  versionMessage,
} from "./live.setup";

/** How the relay reports what went wrong, for the service's log. */
export type LiveLog = (
  level: "error" | "warn",
  details: Record<string, unknown>,
  message: string,
) => void;

export interface RelayOptions {
  /** The Live API's WebSocket URL. */
  url: string;
  auth: GoogleAuth;
  /**
   * The first message on an upstream connection, for the shot the member is on and their
   * version of it; `handle` resumes the conversation a previous connection had.
   */
  setup: (shot: number, handle: string | null, adaptation?: LiveAdaptation) => object;
  /** The plan Director directs, and the shot it starts on. */
  plan: ShotPlan;
  shot: number;
  /** The browser lost Director a moment ago and came straight back: no second hello. */
  resumed: boolean;
  maxDurationMs: number;
  /** How long one upstream connection is used before the relay moves to a fresh one. */
  rotateAfterMs: number;
  /** Camera frames closer together than this are dropped: the Live API takes one a second. */
  frameIntervalMs: number;
  now: () => number;
  log: LiveLog;
  /** Called once, when Gemini's first setup completes and Director truly starts (analytics). */
  onCallStarted: () => void;
}

/** 16 kHz, 16-bit mono: what a microphone sends in real time. */
const AUDIO_BYTES_PER_SECOND = 16_000 * 2;
const AUDIO_WINDOW_MS = 5 * SECOND_MS;
/** Twice real time over the window: room for a burst after the network stalls, no more. */
const AUDIO_WINDOW_BYTES = 2 * AUDIO_BYTES_PER_SECOND * (AUDIO_WINDOW_MS / SECOND_MS);
/** Typed turns: a fast typist's burst, no more. */
const TEXT_TURNS = 6;
const TEXT_WINDOW_MS = 10 * SECOND_MS;
/**
 * Moves to another shot in the same window: a whole plan's worth, so Director skipping
 * to the last shot still fits, and only a browser sending moves in a loop is hung up on.
 */
const SHOT_MOVES = DIRECTOR_MAX_SHOTS;
/**
 * The app's notes (a flip, a take) in the same window. Each makes Gemini think, so a
 * member tapping flip over and over costs at most this many; the rest are dropped, not
 * punished.
 */
const NOTES = 10;
/**
 * What may wait unsent to Gemini: about half a minute of audio. Past it Gemini isn't
 * keeping up, the conversation has fallen too far behind to recover, and it ends.
 */
const UPSTREAM_MAX_BUFFERED_BYTES = 1024 * 1024;
/** How long Gemini waits to hear what came of a tool call before it's told nobody knows. */
const TOOL_ANSWER_MS = 5 * SECOND_MS;
/** What's kept of the conversation, to catch a fresh connection up: lines, and each's length. */
const RECENT_LINES = 8;
const RECENT_LINE_LENGTH = 300;

/** What Gemini hears for each of the browser's answers to a tool call. */
const TOOL_RESPONSES: Record<LiveToolResult | "unknown", object> = {
  unknown: { result: "unknown", why: "The app didn't answer." },
  done: { result: "done" },
  busy: {
    result: "refused",
    why: "A take is under way: counting down, recording or being watched back. Wait until they've kept it or gone again.",
  },
  no_camera: { result: "refused", why: "Their camera isn't on." },
};

/** Tells the browser why Director is going away, then closes the socket. */
export function closeWithError(client: WebSocket, code: ErrorCode) {
  if (client.readyState !== WebSocket.OPEN) {
    return;
  }
  client.send(JSON.stringify({ type: "error", code } satisfies LiveServerMessage));
  // 1011: our side (or Gemini) failed; 1008: it was refused or hit a limit.
  client.close(ERROR_CODES[code] >= 500 ? 1011 : 1008);
}

/**
 * How a call ended: why (the code the browser was told, or null when it hung up) and when
 * it had started, if Gemini ever answered its setup.
 */
export interface CallEnd {
  code: ErrorCode | null;
  startedAt: number | null;
}

type FunctionCall = NonNullable<NonNullable<UpstreamMessage["toolCall"]>["functionCalls"]>[number];

/** One connection to Gemini. */
interface Line {
  socket: WebSocket;
  /** The shot its setup described. */
  shot: number;
  /** Gemini has its setup and listens. */
  ready: boolean;
  /** Replaced by a newer connection: whatever it still says is ignored. */
  retired: boolean;
  /** It picked up a previous connection's conversation from a handle. */
  resumed: boolean;
  /** The member's version of its shot that its setup described, if any. */
  briefed: LiveAdaptation | undefined;
  setupTimer: NodeJS.Timeout | undefined;
}

/** A tool call the browser hasn't answered yet. */
interface Pending {
  line: Line;
  /** The member's version of a shot, applied once the browser has shown it. */
  adaptation?: LiveAdaptation;
  /** Gemini's own id for the call, which its answer must carry. */
  geminiId: string | undefined;
  name: LiveTool;
  timer: NodeJS.Timeout;
}

/** A frame's bytes as text, whichever of ws's shapes it arrived in. */
function textOf(data: RawData): string {
  const chunks = [data].flat().map((chunk) => new Uint8Array(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: the schema that reads the result refuses `undefined` like any bad shape.
    return undefined;
  }
}

function send(line: Line, message: object) {
  line.socket.send(JSON.stringify(message));
}

export class LiveRelay {
  /** The connection Director speaks on, once it's open. */
  private current: Line | null = null;
  /** The connection taking over from `current`, until its setup completes. */
  private next: Line | null = null;
  private rotating = false;
  private handle: string | null = null;
  private ended = false;
  private lastFrameAt = Number.NEGATIVE_INFINITY;
  private readonly audio: SlidingBudget;
  private readonly turns: SlidingBudget;
  private readonly moves: SlidingBudget;
  private readonly notes: SlidingBudget;
  private readonly timer: NodeJS.Timeout;
  private rotateTimer: NodeJS.Timeout | undefined;
  private readonly pending = new Map<string, Pending>();
  private toolIds = 0;
  private readonly recent: { who: "you" | "director"; text: string }[] = [];
  private readonly finished = Promise.withResolvers<CallEnd>();
  /** When Gemini's first setup completed and Director truly started. */
  private startedAt: number | null = null;
  /** The shot the browser is on, which Gemini directs. */
  private shot: number;
  /** The member's version of each shot they changed, by shot. */
  private readonly adaptations = new Map<number, LiveAdaptation>();
  private readonly pacer: Pacer;

  constructor(
    private readonly client: WebSocket,
    private readonly options: RelayOptions,
  ) {
    this.shot = options.shot;
    this.timer = setTimeout(() => this.end("TIMEOUT"), options.maxDurationMs);
    this.audio = new SlidingBudget(AUDIO_WINDOW_BYTES, AUDIO_WINDOW_MS, options.now);
    this.turns = new SlidingBudget(TEXT_TURNS, TEXT_WINDOW_MS, options.now);
    this.moves = new SlidingBudget(SHOT_MOVES, TEXT_WINDOW_MS, options.now);
    this.notes = new SlidingBudget(NOTES, TEXT_WINDOW_MS, options.now);
    this.pacer = new Pacer(
      {
        onQuiet: (nudge) => this.tell(quietMessage(nudge)),
        onNoise: () => this.tell(noiseMessage()),
      },
      options.now,
    );
    client.on("message", (data, isBinary) => this.fromClient(data, isBinary));
    client.on("close", () => this.end(null));
  }

  /** Opens the upstream; resolves once the shoot is over, with how it ended. */
  async run(): Promise<CallEnd> {
    await this.connect("current");
    return this.finished.promise;
  }

  /** Opens a connection to Gemini, as the current one or the one to take over from it. */
  private async connect(as: "current" | "next") {
    let token: string;
    try {
      token = await this.options.auth.accessToken();
    } catch (error) {
      this.options.log("error", { err: describeError(error) }, "no Google access token");
      return this.end("UPSTREAM_UNAVAILABLE");
    }
    if (this.ended) {
      return;
    }
    const socket = new WebSocket(this.options.url, {
      headers: { authorization: `Bearer ${token}` },
      maxPayload: UPSTREAM_MAX_PAYLOAD_BYTES,
      handshakeTimeout: PROVIDER_TIMEOUT_MS,
    });
    const line: Line = {
      socket,
      shot: this.shot,
      ready: false,
      retired: false,
      resumed: false,
      briefed: undefined,
      setupTimer: undefined,
    };
    this[as] = line;
    socket.on("open", () => {
      line.shot = this.shot;
      line.resumed = this.handle !== null;
      line.briefed = this.adaptations.get(line.shot);
      send(line, this.options.setup(line.shot, this.handle, line.briefed));
      line.setupTimer = setTimeout(() => {
        this.options.log("error", {}, "live setup never completed");
        this.end("UPSTREAM_UNAVAILABLE");
      }, PROVIDER_TIMEOUT_MS);
    });
    socket.on("message", (data) => this.fromUpstream(line, data));
    socket.on("error", (error) => {
      if (!(this.ended || line.retired)) {
        this.options.log("error", { err: describeError(error) }, "live upstream failed");
      }
    });
    socket.on("close", (code, reason) => this.lineClosed(line, code, reason.toString("utf8")));
  }

  /** Moves to a fresh connection, unless one is on its way already. */
  private rotate() {
    if (this.rotating || this.ended) {
      return;
    }
    this.rotating = true;
    clearTimeout(this.rotateTimer);
    void this.connect("next");
  }

  private lineClosed(line: Line, code: number, reason: string) {
    clearTimeout(line.setupTimer);
    if (line.retired || this.ended) {
      return;
    }
    // The old connection went before the new one was ready: Director carries on there.
    if (line === this.current && this.rotating) {
      this.current = null;
      return;
    }
    // Vertex reports a refused setup (bad model, field or permission) only this way.
    this.options.log("error", { code, reason }, "live upstream closed");
    this.end("UPSTREAM_UNAVAILABLE");
  }

  private fromClient(data: RawData, isBinary: boolean) {
    const parsed = isBinary ? null : liveClientMessage.safeParse(parseJson(textOf(data)));
    if (!parsed?.success) {
      return this.end("VALIDATION_FAILED");
    }
    const message = parsed.data;
    switch (message.type) {
      case "shot":
        return this.moveTo(message.shot);
      case "tool_result":
        return this.answerTool(message.id, message.result);
      case "context":
        for (const adaptation of message.adaptations) {
          // A shot with nothing changed is the original: there's no version to describe.
          if (adaptation.where || adaptation.action || adaptation.line) {
            this.adaptations.set(adaptation.shot, adaptation);
          }
        }
        return;
      case "camera":
        this.pacer.heard();
        return this.note(cameraMessage(message.facing));
      case "take":
        // From the 3-2-1 to the take's end, quiet is the point.
        this.pacer.take(message.state === "countdown" || message.state === "recording");
        return this.note(takeMessage(message.state, this.shot));
      default:
        return this.forward(message);
    }
  }

  /** The connection Director listens on, once its setup is done. */
  private get ready(): Line | null {
    return this.current?.ready ? this.current : null;
  }

  /**
   * The browser is on shot `index` now. Moves have their own allowance (SHOT_MOVES);
   * before Gemini is ready a move is only remembered, and it opens on that shot.
   */
  private moveTo(index: number) {
    if (index >= this.options.plan.shots.length) {
      return this.end("DIRECTOR_SHOT_NOT_FOUND");
    }
    if (index === this.shot) {
      return;
    }
    if (!this.moves.spend(1)) {
      return this.end("DIRECTOR_CALL_TOO_FAST");
    }
    this.shot = index;
    this.pacer.newShot();
    const line = this.ready;
    if (line) {
      line.shot = index;
      send(line, shotMessage(this.options.plan, index, this.adaptations.get(index)));
    }
  }

  /** A note of the app's own pacing (quiet, noise): it isn't the browser's to spend. */
  private tell(message: object) {
    const line = this.ready;
    if (line) {
      send(line, message);
    }
  }

  /** A note from the app; dropped before Gemini is ready, or past the notes' allowance. */
  private note(message: object) {
    const line = this.ready;
    if (line && this.notes.spend(1)) {
      send(line, message);
    }
  }

  private forward(message: Extract<LiveClientMessage, { type: "audio" | "frame" | "text" }>) {
    // Until Gemini has its setup, anything sent would be refused; a moment's audio is lost.
    const line = this.ready;
    if (!line) {
      return;
    }
    if (line.socket.bufferedAmount > UPSTREAM_MAX_BUFFERED_BYTES) {
      const details = { bufferedBytes: line.socket.bufferedAmount };
      this.options.log("warn", details, "live upstream fell behind");
      return this.end("UPSTREAM_UNAVAILABLE");
    }
    switch (message.type) {
      case "audio":
        if (!this.audio.spend(Buffer.byteLength(message.pcm16, "base64"))) {
          return this.end("DIRECTOR_CALL_TOO_FAST");
        }
        return send(line, {
          realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: message.pcm16 } },
        });
      case "frame": {
        const now = this.options.now();
        if (now - this.lastFrameAt < this.options.frameIntervalMs) {
          return;
        }
        this.lastFrameAt = now;
        return send(line, {
          realtimeInput: { video: { mimeType: "image/jpeg", data: message.jpeg } },
        });
      }
      case "text":
        if (!this.turns.spend(1)) {
          return this.end("DIRECTOR_CALL_TOO_FAST");
        }
        this.pacer.heard();
        return send(line, {
          clientContent: {
            turns: [{ role: "user", parts: [{ text: message.text }] }],
            turnComplete: true,
          },
        });
    }
  }

  private fromUpstream(line: Line, data: RawData) {
    if (line.retired || this.ended) {
      return;
    }
    const parsed = upstreamMessageSchema.safeParse(parseJson(textOf(data)));
    if (!parsed.success) {
      this.options.log("warn", { issues: parsed.error.issues }, "unreadable live message");
      return;
    }
    const message = parsed.data;
    const update = message.sessionResumptionUpdate;
    if (update?.resumable && update.newHandle) {
      this.handle = update.newHandle;
    }
    if (message.setupComplete) {
      this.lineReady(line);
    }
    if (line !== this.current) {
      return;
    }
    if (message.serverContent) {
      this.relayContent(message.serverContent);
    }
    if (message.toolCall) {
      for (const call of message.toolCall.functionCalls ?? []) {
        this.toolCall(line, call);
      }
    }
    if (message.goAway) {
      this.rotate();
    }
  }

  /** Gemini has a connection's setup: Director starts there, or takes over on it. */
  private lineReady(line: Line) {
    // Vertex shouldn't answer a setup twice; if it ever does, nothing starts over.
    if (line.ready) {
      return;
    }
    clearTimeout(line.setupTimer);
    line.ready = true;
    const moved = line.shot !== this.shot;
    line.shot = this.shot;
    const adaptation = this.adaptations.get(this.shot);
    // The member's version arrived after the setup went (the browser sends it as it joins):
    // Director knows it before it says anything.
    if (!moved && adaptation && adaptation !== line.briefed) {
      send(line, versionMessage(adaptation));
    }
    if (line === this.next) {
      this.takeOver(line);
    } else {
      this.startedAt = this.options.now();
      this.options.onCallStarted();
      this.pacer.heard();
      if (!moved) {
        send(line, this.options.resumed ? resumedMessage(this.shot) : greetingMessage(this.shot));
      }
    }
    // The member moved on while this connection got ready: it opens on the shot they're on.
    if (moved) {
      send(line, shotMessage(this.options.plan, this.shot, adaptation));
    }
    clearTimeout(this.rotateTimer);
    this.rotateTimer = setTimeout(() => this.rotate(), this.options.rotateAfterMs);
  }

  /**
   * A fresh connection takes over: the old one is let go (its unanswered tool calls with
   * it), and Gemini is caught up when it couldn't resume the conversation itself.
   */
  private takeOver(line: Line) {
    const old = this.current;
    this.current = line;
    this.next = null;
    this.rotating = false;
    if (old) {
      old.retired = true;
      old.socket.close();
    }
    if (!line.resumed) {
      send(line, catchUpMessage(this.shot, this.recentText()));
    }
  }

  private relayContent(content: NonNullable<UpstreamMessage["serverContent"]>) {
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.mimeType.startsWith("audio/pcm")) {
        this.toClient({ type: "audio", pcm16: part.inlineData.data });
      }
    }
    if (content.inputTranscription?.text) {
      this.transcript("you", content.inputTranscription.text);
    }
    if (content.outputTranscription?.text) {
      this.transcript("director", content.outputTranscription.text);
    }
    if (content.interrupted) {
      this.toClient({ type: "interrupted" });
      this.pacer.interrupted();
    }
    if (content.turnComplete) {
      this.toClient({ type: "turn" });
    }
  }

  private transcript(who: "you" | "director", text: string) {
    this.toClient({ type: "transcript", who, text });
    this.pacer.heard();
    const last = this.recent.at(-1);
    if (last?.who === who) {
      last.text = (last.text + text).slice(-RECENT_LINE_LENGTH);
      return;
    }
    this.recent.push({ who, text: text.slice(-RECENT_LINE_LENGTH) });
    if (this.recent.length > RECENT_LINES) {
      this.recent.shift();
    }
  }

  /** The last few lines said, as Director would read them back. */
  private recentText() {
    return this.recent
      .map(({ who, text }) => `${who === "you" ? "Them" : "You"}: ${text.trim()}`)
      .join("\n");
  }

  /**
   * A tool call: Gemini's arguments checked (a shot the plan has), then handed to the
   * browser, whose answer goes back to Gemini. What can't be done is answered at once.
   */
  private toolCall(line: Line, call: FunctionCall) {
    const name = LIVE_TOOLS.find((tool) => tool === call.name);
    const answerNow = (response: object) =>
      send(line, {
        toolResponse: { functionResponses: [{ id: call.id, name: call.name, response }] },
      });
    if (!name) {
      this.options.log("warn", { tool: call.name }, "unknown live tool call");
      return answerNow({ error: "unknown tool" });
    }
    const browserCall = this.browserCall(name, call.args);
    if ("response" in browserCall) {
      return answerNow(browserCall.response);
    }
    this.toolIds += 1;
    const id = `tool-${this.toolIds}`;
    const timer = setTimeout(() => this.answerTool(id, "unknown"), TOOL_ANSWER_MS);
    const adaptation = browserCall.call.name === "adapt_shot" ? browserCall.call : undefined;
    this.pending.set(id, { line, geminiId: call.id, name, timer, adaptation });
    this.toClient({ type: "tool", id, call: browserCall.call });
  }

  private browserCall(name: LiveTool, raw: unknown): { call: LiveToolCall } | { response: object } {
    switch (name) {
      case "go_to_shot": {
        const args = toolArgsSchemas.go_to_shot.safeParse(raw ?? {});
        if (!args.success) {
          return { response: { error: "shot must be a whole number" } };
        }
        const count = this.options.plan.shots.length;
        const { shot } = args.data;
        if (shot < 1 || shot > count) {
          return {
            response: {
              result: "not_found",
              why: `There's no shot ${shot}: they go from 1 to ${count}.`,
            },
          };
        }
        return { call: { name, shot: shot - 1 } };
      }
      case "switch_camera": {
        const args = toolArgsSchemas.switch_camera.safeParse(raw ?? {});
        if (!args.success) {
          return { response: { error: 'to must be "front" or "back"' } };
        }
        return { call: { name, to: args.data.to } };
      }
      case "adapt_shot":
        return this.adaptCall(raw);
    }
  }

  /**
   * The member's version of a shot, as Gemini put it: a shot the plan has, and at least
   * one of where, what and the line, each a sentence or two (the contract's bounds).
   */
  private adaptCall(raw: unknown): { call: LiveToolCall } | { response: object } {
    const args = toolArgsSchemas.adapt_shot.safeParse(raw ?? {});
    if (!args.success) {
      return { response: { error: "shot must be a whole number, the rest text" } };
    }
    const { shot, where, action, line } = args.data;
    const count = this.options.plan.shots.length;
    if (shot < 1 || shot > count) {
      return {
        response: {
          result: "not_found",
          why: `There's no shot ${shot}: they go from 1 to ${count}.`,
        },
      };
    }
    const adaptation = liveAdaptation.safeParse({ shot: shot - 1, where, action, line });
    if (!adaptation.success) {
      return { response: { error: "each of where, action and line is one to 300 characters" } };
    }
    const { data } = adaptation;
    if (!(data.where || data.action || data.line)) {
      return { response: { error: "say what changed: where, action or line" } };
    }
    return { call: { name: "adapt_shot", ...data } };
  }

  /**
   * Tells Gemini what came of a tool call, once; a late or unknown answer is ignored. A
   * version of a shot the browser showed is kept, for the next time Gemini hears of it.
   */
  private answerTool(id: string, result: LiveToolResult | "unknown") {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const { line, geminiId, name, adaptation } = pending;
    if (adaptation && result === "done") {
      const { shot } = adaptation;
      this.adaptations.set(shot, { ...this.adaptations.get(shot), ...adaptation });
    }
    const response = TOOL_RESPONSES[result];
    if (!line.retired && line.socket.readyState === WebSocket.OPEN) {
      send(line, { toolResponse: { functionResponses: [{ id: geminiId, name, response }] } });
    }
  }

  // The browser's socket is open whenever this runs (Gemini answered while it was). One
  // that is closing drops what's sent, which is right: the shoot is ending anyway.
  private toClient(message: LiveServerMessage) {
    this.client.send(JSON.stringify(message));
  }

  /** Ends the shoot once: `code` is why, for the browser, or null when it hung up. */
  private end(code: ErrorCode | null) {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.pacer.stop();
    clearTimeout(this.timer);
    clearTimeout(this.rotateTimer);
    for (const line of [this.current, this.next]) {
      clearTimeout(line?.setupTimer);
      line?.socket.close();
    }
    for (const { timer } of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
    if (code) {
      closeWithError(this.client, code);
    }
    this.finished.resolve({ code, startedAt: this.startedAt });
  }
}
