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
import {
  DIRECTOR_MAX_SHOTS,
  EMPTY_VERSION,
  type ShotPlan,
  type YourVersion,
} from "@repo/contracts/api";
import { ERROR_CODES, type ErrorCode } from "@repo/contracts/errors";
import {
  type LiveClientMessage,
  type LiveServerMessage,
  type LiveTool,
  type LiveToolResult,
  liveClientMessage,
} from "@repo/contracts/live";
import { PROVIDER_TIMEOUT_MS, SECOND_MS } from "@repo/contracts/time";
import { describeError } from "@repo/nest-common";
import { type RawData, WebSocket } from "ws";
import type { GoogleAuth } from "./google-auth";
import { SlidingBudget } from "./live.budget";
import { POINT_AT_ANSWER_MS } from "./live.marks";
import {
  UPSTREAM_MAX_PAYLOAD_BYTES,
  type UpstreamMessage,
  upstreamMessageSchema,
} from "./live.messages";
import { Pacer } from "./live.pacer";
import { type LivePicks, RATE_TOOL, rate, ShotTally } from "./live.picks";
import {
  adaptationOf,
  briefOf,
  cameraMessage,
  catchUpMessage,
  forgotMessage,
  greetingMessage,
  memoryOf,
  noiseMessage,
  quietMessage,
  restoredMessage,
  resumedMessage,
  rollMessage,
  shotMessage,
  takeMessage,
  versionMessage,
} from "./live.setup";
import { checkTool, TOOL_RESPONSES, toolNamed } from "./live.tools";
import { type LiveTurn, TurnMeter } from "./live.turns";

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
   * version of the plan; `handle` resumes the conversation a previous connection had.
   */
  setup: (shot: number, handle: string | null, version: YourVersion) => object;
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
  /** Where "use the second one" makes a take the member's choice (live.picks.ts). */
  picks: LivePicks;
  /** Called as each of Director's turns ends, with the shot it was on (analytics, no words). */
  onTurn: (turn: LiveTurn, shot: number) => void;
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
/**
 * A re-plan is a model call of its own (director.revise), answered within the AI
 * service's own bound: Gemini waits that long for it, plus the trip there and back.
 */
const REPLAN_ANSWER_MS = 30 * SECOND_MS;
/** The tools whose answer takes longer than an ordinary one's. */
const ANSWER_WITHIN: Partial<Record<LiveTool, number>> = {
  point_at: POINT_AT_ANSWER_MS,
  replan: REPLAN_ANSWER_MS,
};
/** What's kept of the conversation, to catch a fresh connection up: lines, and each's length. */
const RECENT_LINES = 8;
const RECENT_LINE_LENGTH = 300;

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
  /** What its setup said of the member's version (briefOf), to tell it of a newer one. */
  briefed: string;
  setupTimer: NodeJS.Timeout | undefined;
}

/** A tool call the browser hasn't answered yet. */
interface Pending {
  line: Line;
  /** The member's version of a shot, applied once the browser has shown it. */
  adaptation?: YourVersion["shots"][number];
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
  /** The member's version of the plan, as the browser last sent it (and Director changed it). */
  private version: YourVersion = EMPTY_VERSION;
  private readonly pacer: Pacer;
  /** The shoot's attempts and Director's ratings of them, for `rate`. */
  private readonly tally = new ShotTally();
  private readonly turn: TurnMeter;

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
    this.turn = new TurnMeter(options.now);
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
      briefed: "",
      setupTimer: undefined,
    };
    this[as] = line;
    socket.on("open", () => {
      line.shot = this.shot;
      line.resumed = this.handle !== null;
      line.briefed = briefOf(this.version, line.shot);
      send(line, this.options.setup(line.shot, this.handle, this.version));
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
        // The screen's version is the member's: it replaces whatever the relay held.
        this.version = message.version;
        return;
      case "forgot":
        return this.note(forgotMessage(message));
      case "restored":
        return this.note(restoredMessage(message.shot, message.row));
      case "camera":
        this.pacer.heard();
        return this.note(cameraMessage(message.facing));
      case "take":
        // From the 3-2-1 to the take's end, quiet is the point.
        this.pacer.take(message.state === "countdown" || message.state === "recording");
        this.tally.onTake(message.state, this.shot);
        return this.note(takeMessage(message.state, this.shot));
      case "roll":
        // Paused, nobody's there to nudge; and Done is the end of it.
        this.pacer.take(message.state === "paused" || message.state === "done");
        return this.note(rollMessage(message.state));
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
      send(line, shotMessage(this.options.plan, index, this.version));
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
        this.turn.member("text");
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
    // The member's version arrived after the setup went (the browser sends it as it joins):
    // Director knows it before it says anything.
    if (!moved && briefOf(this.version, this.shot) !== line.briefed) {
      send(line, versionMessage(this.version, this.shot));
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
      send(line, shotMessage(this.options.plan, this.shot, this.version));
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
        this.turn.spoke();
        this.toClient({ type: "audio", pcm16: part.inlineData.data });
      }
    }
    if (content.inputTranscription?.text) {
      this.turn.member("voice");
      this.transcript("you", content.inputTranscription.text);
    }
    if (content.outputTranscription?.text) {
      this.transcript("director", content.outputTranscription.text);
    }
    if (content.interrupted) {
      this.toClient({ type: "interrupted" });
      this.pacer.interrupted();
      this.turn.cutIn();
    }
    if (content.turnComplete) {
      this.toClient({ type: "turn" });
      this.options.onTurn(this.turn.complete(), this.shot);
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
    const name = toolNamed(call.name);
    const answerNow = (response: object) =>
      send(line, {
        toolResponse: { functionResponses: [{ id: call.id, name: call.name, response }] },
      });
    if (call.name === RATE_TOOL) {
      return this.rate(call.args, answerNow);
    }
    if (!name) {
      this.options.log("warn", { tool: call.name }, "unknown live tool call");
      return answerNow({ error: "unknown tool" });
    }
    this.turn.tool(name);
    const browserCall = checkTool(this.options.plan, name, call.args);
    if ("response" in browserCall) {
      return answerNow(browserCall.response);
    }
    this.toolIds += 1;
    const id = `tool-${this.toolIds}`;
    const timer = setTimeout(
      () => this.answerTool(id, "unknown"),
      ANSWER_WITHIN[name] ?? TOOL_ANSWER_MS,
    );
    // An attempt under way: no nudges while it runs, as with a take.
    if (browserCall.call.name === "mark") {
      this.pacer.take(browserCall.call.event === "start");
      // An attempt that ended is one more of this shot, for `rate`'s numbering.
      if (browserCall.call.event === "end") {
        this.tally.onTake("recorded", this.shot);
      }
    }
    const adaptation = browserCall.call.name === "adapt_shot" ? browserCall.call : undefined;
    this.pending.set(id, { line, geminiId: call.id, name, timer, adaptation });
    this.toClient({ type: "tool", id, call: browserCall.call });
  }

  /** Director rated an attempt, or the member said which to use: answered once it's done. */
  private rate(args: unknown, answer: (response: object) => void) {
    const { plan, picks } = this.options;
    rate(args, this.shot, plan.shots.length, this.tally, picks).then(answer, (error: unknown) => {
      this.options.log("error", { err: describeError(error) }, "rating a take failed");
      answer({ result: "failed", why: "It couldn't be saved just now." });
    });
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
      const others = this.version.shots.filter(({ shot }) => shot !== adaptation.shot);
      const merged = { ...adaptationOf(this.version, adaptation.shot), ...adaptation };
      this.version = { ...this.version, shots: [...others, merged] };
    }
    // A re-plan's answer carries the new version (the browser sent it just before), so
    // Director confirms what really changed.
    const response =
      name === "replan" && result === "done"
        ? { result: "done", yourVersion: memoryOf(this.version) }
        : TOOL_RESPONSES[result];
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
