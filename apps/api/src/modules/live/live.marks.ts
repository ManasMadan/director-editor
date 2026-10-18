/**
 * Director's marks on the picture (`point_at`): everything the relay needs to know about
 * the tool in one place, so live.relay.ts and live.setup.ts only route to it. Gemini names
 * a thing it can see and a short label; the browser finds it in the current frame
 * (`director.locate`, Gemini 3.8 Flash), pins a box to it, and answers `done`, or
 * `not_found` when it isn't in view, so Director says so instead of drawing a guess.
 */
import {
  DIRECTOR_LOCATE_TARGET_MAX_LENGTH,
  DIRECTOR_MARK_LABEL_MAX_LENGTH,
} from "@repo/contracts/api";
import type { LiveToolCall } from "@repo/contracts/live";
import { SECOND_MS } from "@repo/contracts/time";
import * as z from "zod";

/**
 * How long Gemini waits for a mark: the browser captures a frame and asks Gemini Flash
 * where the thing is (a second or two, the locate's own timeout well past that), before
 * it's told nobody knows.
 */
export const POINT_AT_ANSWER_MS = 12 * SECOND_MS;

/** What Gemini hears when the thing it pointed at isn't in the camera's view. */
export const NOT_FOUND_RESPONSE = {
  result: "not_found",
  why: "It isn't in their camera's view right now, so nothing was drawn. Tell them you can't see it.",
};

/** How Gemini's Live API is told about the tool. */
export const POINT_AT_DECLARATION = {
  description:
    "Draw a labelled box on their screen around something you can see in their camera right now (a window, a lamp, a spot to stand), so showing beats telling. Say what you're pointing at as you do. Not during a take; one thing per call.",
  parameters: {
    type: "OBJECT",
    properties: {
      target: {
        type: "STRING",
        description:
          'What to find in the camera, specific enough to find: "the window behind you", "the floor in front of the sofa".',
      },
      label: {
        type: "STRING",
        description: 'Two or three plain words shown on the box: "your window", "stand here".',
      },
    },
    required: ["target", "label"],
  },
};

/** The persona's rule for marks: only for what Director can see right now. */
export const MARKS_PERSONA = `Showing on their screen:
- Use point_at to put a labelled box on something you can see in their camera right now, when showing beats telling ("stand in front of your window": point at the window). Say it out loud too: the box is a help, not a replacement for your words.
- Never point at something you can't see, and never during a take. If it comes back not found, say you can't see it and ask them to show you, in a few words.`;

const pointAtArgs = z.object({
  target: z.string().trim().min(1).max(DIRECTOR_LOCATE_TARGET_MAX_LENGTH),
  label: z.string().trim().min(1).max(DIRECTOR_MARK_LABEL_MAX_LENGTH),
});

/**
 * Gemini's `point_at` arguments, checked against the contract's bounds before the browser
 * sees them; what doesn't fit is answered at once, so Gemini can try again shorter.
 */
export function pointAtCall(raw: unknown): { call: LiveToolCall } | { response: object } {
  const args = pointAtArgs.safeParse(raw ?? {});
  if (!args.success) {
    return {
      response: {
        error: `target is up to ${DIRECTOR_LOCATE_TARGET_MAX_LENGTH} characters, label up to ${DIRECTOR_MARK_LABEL_MAX_LENGTH}, both needed`,
      },
    };
  }
  return { call: { name: "point_at", ...args.data } };
}
