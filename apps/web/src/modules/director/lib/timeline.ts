/** Where a take is at `seconds` from its start: the teleprompter's line and the step. */
import type { Shot } from "@repo/contracts/api";

/** The line being said at `seconds`, or the next one to come (-1 once all are said). */
export function activeLine(script: Shot["script"], seconds: number): number {
  const index = script.findIndex((line) => seconds < line.endSeconds);
  return index;
}

/** The step in progress at `seconds` (the first one before it starts). */
export function activeStep(steps: Shot["steps"], seconds: number): number {
  let current = 0;
  for (const [index, step] of steps.entries()) {
    if (step.atSeconds <= seconds) {
      current = index;
    }
  }
  return current;
}

/** How far through the line at `index` the take is, from 0 to 1 (for the prompter's sweep). */
export function lineProgress(script: Shot["script"], index: number, seconds: number): number {
  const line = script[index];
  if (!line) {
    return 0;
  }
  const length = line.endSeconds - line.startSeconds;
  if (length <= 0) {
    return seconds >= line.startSeconds ? 1 : 0;
  }
  return Math.min(1, Math.max(0, (seconds - line.startSeconds) / length));
}
