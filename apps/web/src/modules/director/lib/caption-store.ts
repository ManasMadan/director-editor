/**
 * Director live's captions, in a store of their own rather than the shoot screen's state.
 * Transcripts arrive a few words at a time, many times a second while Director talks;
 * held in the screen's state, each would re-render the whole shoot screen (the card, the
 * controls, the marks), on a phone that is also encoding a frame a second and playing
 * audio, and the caption would paint late. Only the captions read this store
 * (`useCaptions`), so a chunk re-renders the caption bubble and nothing else.
 *
 * Director's words are shown as its voice reaches them, not as their text arrives: the
 * session says how far ahead the voice is queued (`delayMs`), and chunks wait that long,
 * in order. When the member talks over Director, words it never got to say are dropped,
 * and its line ends once its voice has played, not when Gemini finished sending it.
 */
import { SECOND_MS } from "@repo/contracts/time";
import {
  answered,
  type Captions,
  NO_CAPTIONS,
  type Speaker,
  turnEnded,
  withoutMember,
  withTranscript,
  withTyped,
} from "./live";

/** How long the member's line stays up once Director has answered it. */
export const ANSWERED_FOR_MS = 8 * SECOND_MS;

/** What Director is busy with that the member can't hear: a re-plan takes a while. */
export type Working = "replanning" | null;

interface Shown {
  captions: Captions;
  working: Working;
}

interface Pending {
  /** When it shows, on `now`'s clock. */
  at: number;
  step: (captions: Captions) => Captions;
  /** The member's own words: never dropped with what Director didn't get to say. */
  member: boolean;
}

/** Steps that wait their time on `now`'s clock, then `apply`, in the order they came. */
function createQueue(now: () => number, apply: (step: Pending["step"]) => void) {
  let pending: Pending[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    clearTimeout(timer);
    const due = pending.filter((entry) => entry.at <= now());
    pending = pending.slice(due.length);
    for (const entry of due) {
      apply(entry.step);
    }
    const next = pending[0];
    if (next) {
      timer = setTimeout(run, next.at - now());
    }
  };
  return {
    /** A step `delayMs` from now, never before the ones already waiting. */
    later(delayMs: number, step: Pending["step"], member = false) {
      const at = Math.max(now() + delayMs, pending.at(-1)?.at ?? 0);
      pending = [...pending, { at, step, member }];
      run();
    },
    /** Nothing waiting shows. */
    drop() {
      pending = [];
      clearTimeout(timer);
    },
    /** Director's words still waiting never show: `step` now, then the member's waiting words. */
    cut(step: Pending["step"]) {
      const kept = pending.filter((entry) => entry.member);
      pending = [];
      clearTimeout(timer);
      for (const each of [step, ...kept.map((entry) => entry.step)]) {
        apply(each);
      }
    },
  };
}

export function createCaptionStore(now: () => number = () => performance.now()) {
  let shown: Shown = { captions: NO_CAPTIONS, working: null };
  let fade: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  const publish = (next: Shown) => {
    const wasAnswered = answered(shown.captions);
    shown = next;
    const isAnswered = answered(shown.captions);
    if (isAnswered && !wasAnswered) {
      fade = setTimeout(() => change(withoutMember), ANSWERED_FOR_MS);
    } else if (!isAnswered) {
      clearTimeout(fade);
    }
    for (const listener of listeners) {
      listener();
    }
  };
  const change = (step: (captions: Captions) => Captions) => {
    const captions = step(shown.captions);
    if (captions !== shown.captions) {
      publish({ ...shown, captions });
    }
  };
  const queue = createQueue(now, (step) => change(step));

  return {
    get: () => shown,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /**
     * Words from `who`, `delayMs` from now (Director's, as its voice reaches them), and
     * never before the words already waiting: the member's answer goes under what Director
     * was still saying, as it was heard.
     */
    said(who: Speaker, text: string, delayMs = 0) {
      queue.later(delayMs, (captions) => withTranscript(captions, who, text), who === "you");
    },
    /** A line the member typed: finished as it's sent. */
    typed(text: string) {
      change((captions) => withTyped(captions, text));
    },
    /** Director's turn is over: its line is done once its voice has played, `delayMs` on. */
    turnOver(delayMs = 0) {
      queue.later(delayMs, turnEnded);
    },
    /** The member talked over Director: words it never said don't show, and its line ends. */
    cut() {
      queue.cut(turnEnded);
    },
    /** The member's line goes: they did something that overtook it. */
    withoutMember() {
      change(withoutMember);
    },
    /** What Director is busy with, shown under its line until it's done. */
    working(working: Working) {
      if (working !== shown.working) {
        publish({ ...shown, working });
      }
    },
    /** A fresh start: nothing on screen, nothing waiting. */
    clear() {
      queue.drop();
      clearTimeout(fade);
      publish({ captions: NO_CAPTIONS, working: null });
    },
    /** The screen is going: nothing more shows. */
    stop() {
      queue.drop();
      clearTimeout(fade);
    },
  };
}

export type CaptionStore = ReturnType<typeof createCaptionStore>;
