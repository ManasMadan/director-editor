/**
 * The edit, from the plan and the member's takes: one clip per shot, laid end to end on
 * the timeline. A filmed clip plays the part of its take Gemini picked (or the whole take
 * when it had none); a shot not filmed yet, or still being reviewed, holds its place for
 * the shot's length. The captions are the shots' scripts moved to where their clips play,
 * with any text the member changed.
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

export function clipsOf(shots: readonly Shot[], latest: Map<number, DirectorTake>): Clip[] {
  let at = 0;
  return shots.map((shot, index) => {
    const take = latest.get(index);
    const state = stateOf(take);
    const best = state === "cut" ? take : undefined;
    const picked = best !== undefined && best.bestStartMs !== null && best.bestEndMs !== null;
    const from = picked ? (best.bestStartMs ?? 0) / 1000 : 0;
    const to = picked ? (best.bestEndMs ?? 0) / 1000 : shot.durationSeconds;
    const seconds = shot.kind === "video" && state === "cut" ? to - from : shot.durationSeconds;
    const clip: Clip = { index, shot, take: take ?? null, state, at, seconds, from, to };
    at += seconds;
    return clip;
  });
}

/** Whether every shot is filmed and reviewed, so the short can be made. */
export const complete = (clips: readonly Clip[]) => clips.every((clip) => clip.state === "cut");

export const editSeconds = (clips: readonly Clip[]) =>
  clips.reduce((sum, clip) => sum + clip.seconds, 0);

/** The clip playing at `seconds` (the last one at the very end). */
export function clipAt(clips: readonly Clip[], seconds: number): Clip | undefined {
  return clips.find((clip) => seconds < clip.at + clip.seconds) ?? clips.at(-1);
}

export interface EditLine extends CaptionLine {
  /** Which shot's script line this is, to keep the member's text for it. */
  key: string;
  clip: number;
}

/** The caption lines on the edit's clock, cut to their clip; `texts` replaces lines by key. */
export function editLines(
  clips: readonly Clip[],
  texts: Readonly<Record<string, string>> = {},
): EditLine[] {
  return clips.flatMap((clip) => {
    const from = clip.shot.kind === "video" && clip.state === "cut" ? clip.from : 0;
    const end = clip.at + clip.seconds;
    return clip.shot.script.flatMap((line, at) => {
      const key = `${clip.index}:${at}`;
      const startSeconds = Math.min(end, clip.at + Math.max(0, line.startSeconds - from));
      const endSeconds = Math.min(end, clip.at + Math.max(0, line.endSeconds - from));
      // A line the kept part leaves out isn't shown.
      return endSeconds > startSeconds
        ? [{ key, clip: clip.index, text: texts[key] ?? line.text, startSeconds, endSeconds }]
        : [];
    });
  });
}
