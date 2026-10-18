/**
 * The conversation's pacing, as the relay sees it: when nobody has said anything for a
 * while, and when the member keeps getting cut off. Director hears about each as a note
 * (live.setup.ts) and decides what to say; this only decides when.
 *
 * Quiet: fifteen seconds without a word from either side (or a typed line, or anything the
 * member did on screen) outside a take brings a nudge, at most twice a shot. Noise: three
 * interruptions inside thirty seconds mean the room is cutting the member off; Director
 * hears that once a shoot.
 */
import { SECOND_MS } from "@repo/contracts/time";

/** How long a quiet stretch lasts before Director nudges. */
export const QUIET_MS = 15 * SECOND_MS;
/** Nudges a shot can have: a light one, then "I'll wait, just say when". */
const NUDGES_PER_SHOT = 2;
const NOISY_INTERRUPTIONS = 3;
const NOISY_WINDOW_MS = 30 * SECOND_MS;

export interface PacerEvents {
  onQuiet: (nudge: 1 | 2) => void;
  onNoise: () => void;
}

export class Pacer {
  private timer: NodeJS.Timeout | undefined;
  private nudges = 0;
  private inTake = false;
  private stopped = false;
  private noiseTold = false;
  private interruptions: number[] = [];

  constructor(
    private readonly events: PacerEvents,
    private readonly now: () => number,
  ) {}

  /** Something was said, typed or done: the quiet starts over. */
  heard() {
    clearTimeout(this.timer);
    if (this.stopped || this.inTake || this.nudges >= NUDGES_PER_SHOT) {
      return;
    }
    this.timer = setTimeout(() => {
      this.nudges += 1;
      this.events.onQuiet(this.nudges === 1 ? 1 : 2);
      this.heard();
    }, QUIET_MS);
  }

  /** From the 3-2-1 to the take's end, silence is the point: no nudges. */
  take(on: boolean) {
    this.inTake = on;
    this.heard();
  }

  /** A new shot: its own two nudges. */
  newShot() {
    this.nudges = 0;
    this.heard();
  }

  /** The member talked over Director. */
  interrupted() {
    const now = this.now();
    this.interruptions = [...this.interruptions.filter((at) => now - at < NOISY_WINDOW_MS), now];
    if (!this.noiseTold && this.interruptions.length >= NOISY_INTERRUPTIONS) {
      this.noiseTold = true;
      this.events.onNoise();
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
