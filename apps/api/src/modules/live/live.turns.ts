/**
 * What each of Director's turns on the live line looked like, for product analytics
 * (BigQuery `director.events`, kind `director_turn`): what started it, which tools it
 * called, whether the member cut in, and how long the member waited for Director's
 * voice. Never the words: what was said stays in the browser's transcript and in the
 * recording the member agreed to on the consent card, not in analytics.
 *
 * Latency is measured from the last thing heard from the member before Director spoke
 * (a typed line, or the latest piece of their speech's transcription) to Director's
 * first audio. Gemini transcribes speech a little behind it, so a spoken turn's figure
 * is a slight underestimate; a typed one is exact.
 */
import type { LiveTool } from "@repo/contracts/live";
import type { RATE_TOOL } from "./live.picks";

/** A tool Director called: the browser's, or `rate`, which the relay answers itself. */
type TurnTool = LiveTool | typeof RATE_TOOL;

/** What the member did that Director answered: spoke, typed, or nothing (the app's note). */
export type TurnInput = "voice" | "text" | "app";

export interface LiveTurn {
  input: TurnInput;
  /** The member's wait for Director's voice; null when Director didn't speak or nobody asked. */
  latencyMs: number | null;
  /** The tools Director called in the turn, in order. */
  tools: TurnTool[];
  /** The member talked over Director. */
  interrupted: boolean;
  /** Director said something aloud (a turn can be only a tool call). */
  spoke: boolean;
  /** How long Director's voice in the turn plays, from the audio Gemini sent. */
  voiceMs: number;
  /**
   * How long after the turn's first audio its first words of transcript came from Gemini
   * (negative when the words came first); null without both. The captions can't show
   * words before they arrive, so this is how late they are at the start of a turn, before
   * the network and the phone add their own.
   */
  captionLagMs: number | null;
}

/** Live's voice is 24 kHz 16-bit mono: 48 bytes a millisecond. */
const VOICE_BYTES_PER_MS = 48;

export class TurnMeter {
  private heardAt: number | null = null;
  private heard: Exclude<TurnInput, "app"> | null = null;
  private spokeAt: number | null = null;
  private saidAt: number | null = null;
  private voiceBytes = 0;
  private tools: TurnTool[] = [];
  private interrupted = false;

  constructor(private readonly now: () => number) {}

  /** The member said or typed something; only what came before Director spoke counts. */
  member(how: "voice" | "text") {
    if (this.spokeAt !== null) {
      return;
    }
    this.heardAt = this.now();
    this.heard = how;
  }

  /** A piece of Director's voice: the first one is when the member stopped waiting. */
  spoke(bytes: number) {
    this.spokeAt ??= this.now();
    this.voiceBytes += bytes;
  }

  /** Whether Director's voice has come in the turn so far. */
  speaking(): boolean {
    return this.spokeAt !== null;
  }

  /** A piece of the transcript of Director's voice. */
  said() {
    this.saidAt ??= this.now();
  }

  tool(name: TurnTool) {
    this.tools.push(name);
  }

  cutIn() {
    this.interrupted = true;
  }

  /** The turn ended: what it was, and a clean slate for the next one. */
  complete(): LiveTurn {
    const turn: LiveTurn = {
      input: this.heard ?? "app",
      latencyMs:
        this.heardAt !== null && this.spokeAt !== null
          ? Math.max(0, this.spokeAt - this.heardAt)
          : null,
      tools: this.tools,
      interrupted: this.interrupted,
      spoke: this.spokeAt !== null,
      voiceMs: Math.round(this.voiceBytes / VOICE_BYTES_PER_MS),
      captionLagMs:
        this.saidAt !== null && this.spokeAt !== null ? this.saidAt - this.spokeAt : null,
    };
    this.heardAt = null;
    this.heard = null;
    this.spokeAt = null;
    this.saidAt = null;
    this.voiceBytes = 0;
    this.tools = [];
    this.interrupted = false;
    return turn;
  }
}
