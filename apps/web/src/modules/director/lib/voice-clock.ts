/**
 * When Director's voice plays, for its captions. Gemini sends a turn's audio faster than
 * it plays, and its transcript separately, so a caption shown when its text arrives can
 * run seconds ahead of the voice (or, at a turn's start, a little behind it). The player
 * (live-audio.ts) queues each chunk right after the one before; this follows the same
 * queue, on the same audio clock, to say when a turn's words are heard.
 *
 * Gemini's transcript carries no timing, so a chunk's words are placed by how much of the
 * turn has been said before them, at an even speaking pace: close enough to keep the
 * caption with the voice, never earlier than the turn's first sound. Words that arrive
 * after their moment show at once: a caption can't be shown before its text exists.
 */

import { SECOND_MS } from "@repo/contracts/time";

/** About how fast Director's voice speaks, in characters a second (some 160 words a minute). */
export const CHARS_PER_SECOND = 15;

export interface TurnTiming {
  /** From the turn's first audio arriving to its first words of transcript (ms). */
  textAfterAudioMs: number | null;
  /** How far ahead of its playing the turn's first audio arrived (ms). */
  queuedAheadMs: number | null;
  /** How long the captions waited for the voice, at most, in the turn (ms). */
  heldMs: number;
  /** The turn's voice, in ms. */
  voiceMs: number;
}

interface Turn {
  /** When its first sound plays, on the audio clock (s). */
  startsAt: number | null;
  /** Its transcript so far, in characters. */
  chars: number;
  /** Its voice so far (s). */
  voice: number;
  /** The longest a caption waited for the voice (ms). */
  held: number;
}

/** When the turn's first audio and first words arrived, and how far ahead the audio was (s). */
interface Arrivals {
  audio: number | null;
  text: number | null;
  ahead: number | null;
}

const FRESH_TURN: Turn = { startsAt: null, chars: 0, voice: 0, held: 0 };
const NOTHING_YET: Arrivals = { audio: null, text: null, ahead: null };

/** `now` is the audio clock, in seconds (AudioContext.currentTime). */
export function createVoiceClock(now: () => number) {
  let endsAt = 0;
  let turn = FRESH_TURN;
  let arrivals = NOTHING_YET;

  return {
    /** A chunk of `seconds` was queued: it plays right after what's queued already. */
    queued(seconds: number) {
      const startsAt = Math.max(now(), endsAt);
      endsAt = startsAt + seconds;
      turn = { ...turn, startsAt: turn.startsAt ?? startsAt, voice: turn.voice + seconds };
      arrivals = {
        ...arrivals,
        audio: arrivals.audio ?? now(),
        ahead: arrivals.ahead ?? startsAt - now(),
      };
    },
    /** How long `text`, the next of the turn's words, waits for the voice to reach it (ms). */
    wait(text: string): number {
      arrivals = { ...arrivals, text: arrivals.text ?? now() };
      const at = turn.startsAt === null ? now() : turn.startsAt + turn.chars / CHARS_PER_SECOND;
      turn = { ...turn, chars: turn.chars + text.length };
      const waitMs = Math.max(0, (at - now()) * SECOND_MS);
      turn = { ...turn, held: Math.max(turn.held, waitMs) };
      return waitMs;
    },
    /** How long the voice queued so far still plays (ms). */
    leftMs(): number {
      return Math.max(0, (endsAt - now()) * SECOND_MS);
    },
    /** The turn is over: what its timing was, and a fresh count for the next one. */
    turnOver(): TurnTiming {
      const { audio, text, ahead } = arrivals;
      const timing = {
        textAfterAudioMs:
          audio !== null && text !== null ? Math.round((text - audio) * SECOND_MS) : null,
        queuedAheadMs: ahead === null ? null : Math.round(ahead * SECOND_MS),
        heldMs: Math.round(turn.held),
        voiceMs: Math.round(turn.voice * SECOND_MS),
      };
      turn = FRESH_TURN;
      arrivals = NOTHING_YET;
      return timing;
    },
    /** What was queued was dropped (the member cut in, or a take holds the voice). */
    flushed() {
      endsAt = 0;
      turn = { startsAt: null, chars: 0, voice: turn.voice, held: turn.held };
    },
  };
}

export type VoiceClock = ReturnType<typeof createVoiceClock>;
