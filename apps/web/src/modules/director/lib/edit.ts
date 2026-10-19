/**
 * The edit, from the plan and the take picked for each shot (lib/picks.ts): one clip per
 * shot, laid end to end. A filmed clip plays the part of its take Gemini kept (or the
 * whole take when it kept none, or kept too little to use); a shot not filmed yet, or
 * whose take is still being reviewed, holds its place for the shot's length. A shot the
 * member's version leaves as a gap holds its place too; one it skips has no clip. A gap,
 * and a shot still not filmed when the video is saved, play as moments for B-roll to
 * fill (lib/scene.ts). The captions are the filmed shots' scripts moved to where their
 * clips play.
 */
import type { DirectorTake, EditorGrade, Shot } from "@repo/contracts/api";
import type { CaptionLine } from "./captions";

type ClipState = "cut" | "missing" | "reviewing" | "gap";

/** Whether a shot is in the member's edit: filmed, left as a gap to fill, or not at all. */
type InEdit = "filmed" | "gap" | null;

/**
 * The shortest kept part worth playing. Gemini has kept a tenth of a second of a take, a
 * flash nobody can follow; the clipper won't cut a take shorter than this either.
 */
export const MIN_KEPT_SECONDS = 0.5;

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
  /** The look graded over its picture, when one was asked for (lib/grades.ts). */
  grade?: EditorGrade;
}

function stateOf(take: DirectorTake | undefined): ClipState {
  if (!take) {
    return "missing";
  }
  return take.status === "pending" || take.status === "reviewing" ? "reviewing" : "cut";
}

/** The part of a take that plays: Gemini's pick, or the whole take when it kept too little. */
function keptPart(take: DirectorTake | undefined, shot: Shot) {
  if (take && take.bestStartMs !== null && take.bestEndMs !== null) {
    const from = take.bestStartMs / 1000;
    const to = take.bestEndMs / 1000;
    if (to - from >= MIN_KEPT_SECONDS) {
      return { from, to };
    }
  }
  return { from: 0, to: shot.durationSeconds };
}

export function clipsOf(
  shots: readonly Shot[],
  picked: Map<number, DirectorTake>,
  inEdit: (index: number) => InEdit = () => "filmed",
): Clip[] {
  let at = 0;
  return shots.flatMap((shot, index) => {
    const part = inEdit(index);
    if (part === null) {
      return [];
    }
    const take = part === "gap" ? undefined : picked.get(index);
    const state = part === "gap" ? "gap" : stateOf(take);
    const { from, to } = keptPart(state === "cut" ? take : undefined, shot);
    const seconds = shot.kind === "video" && state === "cut" ? to - from : shot.durationSeconds;
    const clip: Clip = { index, shot, take: take ?? null, state, at, seconds, from, to };
    at += seconds;
    return [clip];
  });
}

/**
 * Whether a clip plays as a gap in the saved video: left as one by the member's version,
 * or not filmed (the member saved without filming it, as "I've only got three minutes"
 * asks for). Nobody says its lines, so it has no captions.
 */
export const playsAsGap = (clip: Clip) => clip.state === "gap" || clip.state === "missing";

/** Whether every shot is filmed and reviewed, so the video can be made. */
export const complete = (clips: readonly Clip[]) => clips.every((clip) => clip.state === "cut");

export const editSeconds = (clips: readonly Clip[]) =>
  clips.reduce((sum, clip) => sum + clip.seconds, 0);

/** The clip playing at `seconds` (the last one at the very end). */
export function clipAt(clips: readonly Clip[], seconds: number): Clip | undefined {
  return clips.find((clip) => seconds < clip.at + clip.seconds) ?? clips.at(-1);
}

/**
 * The caption lines on the edit's clock, cut to their clip. A gap has none: nobody says
 * its lines over its B-roll.
 */
export function editLines(clips: readonly Clip[]): CaptionLine[] {
  return clips.flatMap((clip) => {
    if (playsAsGap(clip)) {
      return [];
    }
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
