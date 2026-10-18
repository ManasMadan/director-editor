/**
 * The edit, from the plan and the take picked for each shot (lib/picks.ts): one clip per
 * shot, laid end to end. A filmed clip plays the part of its take Gemini kept (or the
 * whole take when it kept none); a shot not filmed yet, or whose take is still being
 * reviewed, holds its place for the shot's length. The captions are the shots' scripts
 * moved to where their clips play.
 */
import type { DirectorTake, Shot } from "@repo/contracts/api";
import type { CaptionLine } from "./captions";

type ClipState = "cut" | "missing" | "reviewing";

export interface Clip {
  index: number;
  shot: Shot;
  take: DirectorTake | null;
  state: ClipState;
  /** Where the clip starts in the edit, and how long it plays, in seconds. */
  at: number;
  seconds: number;
  /** For a filmed video: the part played, in seconds from the take's start. */
  from: number;
  to: number;
}

function stateOf(take: DirectorTake | undefined): ClipState {
  if (!take) {
    return "missing";
  }
  return take.status === "pending" || take.status === "reviewing" ? "reviewing" : "cut";
}

export function clipsOf(shots: readonly Shot[], picked: Map<number, DirectorTake>): Clip[] {
  let at = 0;
  return shots.map((shot, index) => {
    const take = picked.get(index);
    const state = stateOf(take);
    const best = state === "cut" ? take : undefined;
    const { from, to } =
      best && best.bestStartMs !== null && best.bestEndMs !== null
        ? { from: best.bestStartMs / 1000, to: best.bestEndMs / 1000 }
        : { from: 0, to: shot.durationSeconds };
    const seconds = shot.kind === "video" && state === "cut" ? to - from : shot.durationSeconds;
    const clip: Clip = { index, shot, take: take ?? null, state, at, seconds, from, to };
    at += seconds;
    return clip;
  });
}

/** Whether every shot is filmed and reviewed, so the video can be made. */
export const complete = (clips: readonly Clip[]) => clips.every((clip) => clip.state === "cut");

export const editSeconds = (clips: readonly Clip[]) =>
  clips.reduce((sum, clip) => sum + clip.seconds, 0);

/** The clip playing at `seconds` (the last one at the very end). */
export function clipAt(clips: readonly Clip[], seconds: number): Clip | undefined {
  return clips.find((clip) => seconds < clip.at + clip.seconds) ?? clips.at(-1);
}

/** The caption lines on the edit's clock, cut to their clip. */
export function editLines(clips: readonly Clip[]): CaptionLine[] {
  return clips.flatMap((clip) => {
    const from = clip.shot.kind === "video" && clip.state === "cut" ? clip.from : 0;
    const end = clip.at + clip.seconds;
    return clip.shot.script.flatMap((line) => {
      const startSeconds = Math.min(end, clip.at + Math.max(0, line.startSeconds - from));
      const endSeconds = Math.min(end, clip.at + Math.max(0, line.endSeconds - from));
      // A line the kept part leaves out isn't shown.
      return endSeconds > startSeconds ? [{ text: line.text, startSeconds, endSeconds }] : [];
    });
  });
}
