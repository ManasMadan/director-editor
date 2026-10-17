/**
 * One live call: the browser's socket on one side, Gemini's Live API (Vertex AI) on the
 * other. The browser's microphone and camera go up as realtime input; Gemini's voice, both
 * sides' transcripts and its tool calls come back down. The call ends when either side
 * closes, Gemini fails, or the call reaches its time limit; the browser hears why as an
 * `error` message just before its socket closes.
 */
import { ERROR_CODES, type ErrorCode } from "@repo/contracts/errors";
import { PROVIDER_TIMEOUT_MS } from "@repo/contracts/time";
import { describeError } from "@repo/nest-common";
import { type RawData, WebSocket } from "ws";
import type { GoogleAuth } from "./google-auth";
import {
  type ClientMessage,
  clientMessageSchema,
  type ServerMessage,
  toolArgsSchema,
  UPSTREAM_MAX_PAYLOAD_BYTES,
  type UpstreamMessage,
  upstreamMessageSchema,
} from "./live.messages";
import { LIVE_TOOLS } from "./live.setup";

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
  /** The first message upstream (setupMessage), and the turn that makes the director speak. */
  setup: object;
  greeting: object;
  maxDurationMs: number;
  /** Camera frames closer together than this are dropped: the Live API takes one a second. */
  frameIntervalMs: number;
  now: () => number;
  log: LiveLog;
}

/** Tells the browser why its call ended, then closes the socket. */
export function closeWithError(client: WebSocket, code: ErrorCode) {
  if (client.readyState !== WebSocket.OPEN) {
    return;
  }
  client.send(JSON.stringify({ type: "error", code } satisfies ServerMessage));
  // 1011: our side (or Gemini) failed; 1008: the call was refused or hit a limit.
  client.close(ERROR_CODES[code] >= 500 ? 1011 : 1008);
}

type FunctionCall = NonNullable<NonNullable<UpstreamMessage["toolCall"]>["functionCalls"]>[number];

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

export class LiveRelay {
  private upstream: WebSocket | null = null;
  private ready = false;
  private ended = false;
  private lastFrameAt = Number.NEGATIVE_INFINITY;
  private readonly timer: NodeJS.Timeout;
  private readonly finished = Promise.withResolvers<void>();

  constructor(
    private readonly client: WebSocket,
    private readonly options: RelayOptions,
  ) {
    this.timer = setTimeout(() => this.end("TIMEOUT"), options.maxDurationMs);
    client.on("message", (data, isBinary) => this.fromClient(data, isBinary));
    client.on("close", () => this.end(null));
  }

  /** Opens the upstream; resolves once the call is over, however it ended. */
  async run(): Promise<void> {
    await this.connect();
    return this.finished.promise;
  }

  private async connect() {
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
    const upstream = new WebSocket(this.options.url, {
      headers: { authorization: `Bearer ${token}` },
      maxPayload: UPSTREAM_MAX_PAYLOAD_BYTES,
      handshakeTimeout: PROVIDER_TIMEOUT_MS,
    });
    this.upstream = upstream;
    upstream.on("open", () => upstream.send(JSON.stringify(this.options.setup)));
    upstream.on("message", (data) => this.fromUpstream(data));
    upstream.on("error", (error) => {
      if (!this.ended) {
        this.options.log("error", { err: describeError(error) }, "live upstream failed");
      }
    });
    upstream.on("close", (code, reason) => {
      if (!this.ended) {
        // Vertex reports a refused setup (bad model, field or permission) only this way.
        const details = { code, reason: reason.toString("utf8") };
        this.options.log("error", details, "live upstream closed");
      }
      this.end("UPSTREAM_UNAVAILABLE");
    });
  }

  private fromClient(data: RawData, isBinary: boolean) {
    const parsed = isBinary ? null : clientMessageSchema.safeParse(parseJson(textOf(data)));
    if (!parsed?.success) {
      return this.end("VALIDATION_FAILED");
    }
    // Until Gemini has its setup, anything sent would be refused; a moment's audio is lost.
    if (this.ready) {
      this.forward(parsed.data);
    }
  }

  private forward(message: ClientMessage) {
    switch (message.type) {
      case "audio":
        return this.toUpstream({
          realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: message.pcm16 } },
        });
      case "frame": {
        const now = this.options.now();
        if (now - this.lastFrameAt < this.options.frameIntervalMs) {
          return;
        }
        this.lastFrameAt = now;
        return this.toUpstream({
          realtimeInput: { video: { mimeType: "image/jpeg", data: message.jpeg } },
        });
      }
      case "text":
        return this.toUpstream({
          clientContent: {
            turns: [{ role: "user", parts: [{ text: message.text }] }],
            turnComplete: true,
          },
        });
    }
  }

  private fromUpstream(data: RawData) {
    const parsed = upstreamMessageSchema.safeParse(parseJson(textOf(data)));
    if (!parsed.success) {
      this.options.log("warn", { issues: parsed.error.issues }, "unreadable live message");
      return;
    }
    const message = parsed.data;
    if (message.setupComplete) {
      this.ready = true;
      this.toUpstream(this.options.greeting);
    }
    if (message.serverContent) {
      this.relayContent(message.serverContent);
    }
    if (message.toolCall) {
      this.relayToolCalls(message.toolCall.functionCalls ?? []);
    }
  }

  private relayContent(content: NonNullable<UpstreamMessage["serverContent"]>) {
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.mimeType.startsWith("audio/pcm")) {
        this.toClient({ type: "audio", pcm16: part.inlineData.data });
      }
    }
    if (content.inputTranscription?.text) {
      this.toClient({ type: "transcript", who: "you", text: content.inputTranscription.text });
    }
    if (content.outputTranscription?.text) {
      const text = content.outputTranscription.text;
      this.toClient({ type: "transcript", who: "director", text });
    }
    if (content.interrupted) {
      this.toClient({ type: "interrupted" });
    }
  }

  /** Passes each known tool on to the browser and tells Gemini it was done. */
  private relayToolCalls(calls: FunctionCall[]) {
    const functionResponses = calls.map((call) => {
      const name = LIVE_TOOLS.find((tool) => tool === call.name);
      const args = toolArgsSchema.safeParse(call.args ?? {});
      if (!name || !args.success) {
        this.options.log("warn", { tool: call.name }, "unknown live tool call");
        return { id: call.id, name: call.name, response: { error: "unknown tool" } };
      }
      this.toClient({ type: "tool", name, args: args.data });
      return { id: call.id, name, response: { result: "done" } };
    });
    if (functionResponses.length > 0) {
      this.toUpstream({ toolResponse: { functionResponses } });
    }
  }

  // Both sockets are open whenever these run (the upstream has answered setup). One that
  // is closing drops what's sent, which is right: the call is ending anyway.
  private toClient(message: ServerMessage) {
    this.client.send(JSON.stringify(message));
  }

  private toUpstream(message: object) {
    this.upstream?.send(JSON.stringify(message));
  }

  /** Ends the call once: `code` is why, for the browser, or null when it hung up. */
  private end(code: ErrorCode | null) {
    if (this.ended) {
      return;
    }
    this.ended = true;
    clearTimeout(this.timer);
    if (code) {
      closeWithError(this.client, code);
    }
    this.upstream?.close();
    this.finished.resolve();
  }
}
