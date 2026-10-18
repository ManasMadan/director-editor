/**
 * Whether Director may move the member to another shot just now. Right after Director
 * changes their plan (a re-plan, a change to a shot, something remembered), the model
 * tends to move them on by itself: "ok" or "perfect" after it confirms the change reads to
 * it as "next". The member then finds the screen on another shot they never asked for. So
 * for a while after a change, a move needs the member's say-so: words of theirs since
 * the change that ask to move on, or any answer of theirs once Director has been told to
 * ask first (in whatever language they speak, Director judges that answer itself).
 */
import { SECOND_MS } from "@repo/contracts/time";

/** How long after a change to the plan a move needs the member's say-so. */
export const AFTER_CHANGE_MS = 20 * SECOND_MS;

/** Words that ask to move on, in English; any other answer counts once Director has asked. */
const MOVE_ON =
  /\b(?:next|move on|moving on|go on|onto|on to|skip|another shot|other shot|shot \d+|go to|go back|let'?s go|done with|carry on|keep going)\b/i;

export function createMoveGuard(now: () => number) {
  let changedAt = Number.NEGATIVE_INFINITY;
  let askedToMove = false;
  /** A move was refused, and Director told to ask: the member's next words answer it. */
  let refused = false;
  let answered = false;
  return {
    /** Director changed the member's plan. */
    planChanged() {
      changedAt = now();
      askedToMove = false;
      refused = false;
      answered = false;
    },
    /** The member said or typed something. */
    memberSaid(text: string) {
      askedToMove ||= MOVE_ON.test(text);
      answered ||= refused;
    },
    /** Whether Director's move goes ahead; a refusal counts, so the member's answer is awaited. */
    allows(): boolean {
      if (now() - changedAt >= AFTER_CHANGE_MS || askedToMove || answered) {
        return true;
      }
      refused = true;
      return false;
    },
  };
}

export type MoveGuard = ReturnType<typeof createMoveGuard>;
