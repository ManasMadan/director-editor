/**
 * When the app's notes may reach Gemini. The Live API takes any `clientContent` as the
 * member's turn: it stops whatever Director is generating ("interrupted"), even a note
 * that asks for no answer, and the browser then drops the rest of Director's sentence.
 * So a note (a move to another shot, a flip of the camera, a quiet nudge) never goes
 * while a conversation turn is under way:
 *
 * - Director is speaking, or about to: its voice or words came in, it called a tool, or
 *   it was just answered one, which it carries on from;
 * - a tool call is waiting for the browser (Gemini says nothing until it's answered);
 * - the member is talking, and Director will answer them.
 *
 * The turn is over at Gemini's `turnComplete`, or once nothing has come from either side
 * for `TURN_SILENT_MS` (Gemini may stay silent after a tool's answer, or never send the
 * end of a turn it gave up). Held notes then go together, as one turn, so the first
 * doesn't start a reply the second would cut off. A move to another shot keeps only the
 * latest, built when it goes, so it describes the member's version as it is then.
 */
import { SECOND_MS } from "@repo/contracts/time";
import type { AppNote } from "./live.setup";

/**
 * How long a turn with nothing more from Director or the member counts as over. Gemini
 * streams a turn's voice in chunks well under a second apart, and starts answering a
 * tool's response or the member within a second or two.
 */
export const TURN_SILENT_MS = 5 * SECOND_MS;
/** More notes than this waiting means the oldest are stale: they're let go. */
const MAX_HELD = 8;

/** What a note is about, for the log and so a later move replaces an earlier one. */
export type NoteKind =
  | "shot"
  | "version"
  | "forgot"
  | "restored"
  | "camera"
  | "take"
  | "roll"
  | "quiet"
  | "noise"
  | "attempt";

interface Held {
  kind: NoteKind;
  /** Built when it goes, from what the relay knows then. */
  build: () => AppNote;
}

export interface GateEvents {
  /** Whether a tool call is waiting for the browser's answer. */
  waiting: () => boolean;
  /** The turn is over (nobody is speaking, nothing is pending): a good moment to switch lines. */
  idle: () => void;
  /** Sends notes as one turn; `held` says whether any had to wait for a turn to end. */
  deliver: (note: AppNote, kinds: NoteKind[], held: boolean) => void;
}

/** Several notes as one turn, which asks for an answer if any of them does. */
export function together(notes: readonly AppNote[]): AppNote {
  return {
    clientContent: {
      turns: notes.flatMap((note) => note.clientContent.turns),
      turnComplete: notes.some((note) => note.clientContent.turnComplete),
    },
  };
}

export class NoteGate {
  private talking = false;
  private silence: NodeJS.Timeout | undefined;
  private held: Held[] = [];
  /** When the current turn started, for the log of an interruption. */
  private turnStartedAt: number | null = null;

  constructor(
    private readonly events: GateEvents,
    private readonly now: () => number,
  ) {}

  /** Director or the member said something, or a tool call or its answer went by. */
  turnGoesOn() {
    this.turnStartedAt ??= this.now();
    this.talking = true;
    clearTimeout(this.silence);
    this.silence = setTimeout(() => this.turnOver(), TURN_SILENT_MS);
  }

  /** Gemini ended its turn, or it went quiet long enough to count as ended. */
  turnOver() {
    this.talking = false;
    this.turnStartedAt = null;
    clearTimeout(this.silence);
    this.release();
  }

  /** How long the current turn has gone on, or null between turns. */
  turnAge(): number | null {
    return this.turnStartedAt === null ? null : this.now() - this.turnStartedAt;
  }

  /** Whether a conversation turn is under way, so a note would cut it off. */
  get busy() {
    return this.talking || this.events.waiting();
  }

  /** A note: sent now between turns, or held until the turn under way is over. */
  send(kind: NoteKind, build: () => AppNote) {
    if (!this.busy && this.held.length === 0) {
      this.events.deliver(build(), [kind], false);
      return;
    }
    if (kind === "shot") {
      this.held = this.held.filter((note) => note.kind !== "shot");
    }
    this.held = [...this.held, { kind, build }].slice(-MAX_HELD);
  }

  /** Lets held notes go, if the turn is over; a tool call answered calls this too. */
  release() {
    if (this.busy) {
      return;
    }
    this.events.idle();
    const held = this.held;
    this.held = [];
    if (held.length > 0) {
      this.events.deliver(
        together(held.map((note) => note.build())),
        held.map((note) => note.kind),
        true,
      );
    }
  }

  stop() {
    clearTimeout(this.silence);
    this.held = [];
  }
}
