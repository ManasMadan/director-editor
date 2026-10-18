/**
 * Match cuts (the redesign spec's 9.5): something (the anchor, "the watch on the left
 * wrist") stays on the same spot while the world changes between two shots. The plan's
 * edit list names them (a `transition` edit of kind `match-cut`, at the time the next
 * shot starts in the original); the AI service lines each one up (Gemini finds the
 * anchor, OpenCV works out the move), and the editor applies what it answered: the cut
 * points, and a transform for the incoming clip that both the preview and the render
 * draw.
 *
 * Read structurally: a plan written before edits existed has none, and every match cut
 * is then simply absent.
 */
import type { MatchCutAlignment, MatchCutAsk } from "@repo/contracts/api";
import type { VideoId } from "@repo/contracts/ids";
import type { Clip } from "./edit";
import { OUTPUT_HEIGHT, OUTPUT_WIDTH } from "./stitch";

export type MatchCutTransform = MatchCutAlignment["transform"];

/** The part of an edit this file reads: a transition, and the anchor of a match cut. */
interface EditLike {
  type: string;
  startSeconds: number;
  transition?: string | null;
  anchor?: string | null;
}

/** The part of a plan this file reads. */
export interface PlanLike {
  shots: readonly { sourceStartSeconds: number }[];
  edits?: readonly EditLike[];
}

/** How far a transition may sit from a shot's start in the original and still be its cut. */
const NEAR_SECONDS = 0.75;

/**
 * The anchor of the match cut into shot `index` (from the shot before it), or null when
 * that cut isn't a match cut: the transition nearest the shot's start in the original.
 */
export function matchCutInto(plan: PlanLike, index: number): string | null {
  const shot = plan.shots[index];
  if (index === 0 || !shot) {
    return null;
  }
  const edit = (plan.edits ?? []).find(
    (candidate) =>
      candidate.type === "transition" &&
      candidate.transition === "match-cut" &&
      Math.abs(candidate.startSeconds - shot.sourceStartSeconds) <= NEAR_SECONDS,
  );
  return edit?.anchor?.trim() || null;
}

/** A match cut in the edit: into which clip, what stays put, and what to ask about it. */
export interface MatchCut {
  into: number;
  anchor: string;
  ask: MatchCutAsk;
}

/**
 * The edit's match cuts that can be lined up: both clips filmed videos, cut and reviewed.
 * The cut falls at the end of the outgoing clip's kept part and the start of the
 * incoming one's.
 */
export function matchCutsOf(videoId: VideoId, plan: PlanLike, clips: readonly Clip[]): MatchCut[] {
  return clips.flatMap((clip, index) => {
    const before = clips[index - 1];
    const anchor = matchCutInto(plan, index);
    if (!anchor || !before || !filmedVideo(before) || !filmedVideo(clip)) {
      return [];
    }
    return [
      {
        into: index,
        anchor,
        ask: {
          videoId,
          anchor,
          outgoing: { takeId: before.take.id, atMs: Math.round(before.to * 1000) },
          incoming: { takeId: clip.take.id, atMs: Math.round(clip.from * 1000) },
        },
      },
    ];
  });
}

function filmedVideo(clip: Clip): clip is Clip & { take: NonNullable<Clip["take"]> } {
  return clip.shot.kind === "video" && clip.state === "cut" && clip.take !== null;
}

/**
 * The clips with each lined-up match cut applied: the outgoing clip ends and the
 * incoming one starts where the anchor's motion matched, the edit's clock moved to suit.
 * A cut that wasn't lined up (not found, or still on its way) changes nothing.
 */
export function alignClips(
  clips: readonly Clip[],
  aligned: ReadonlyMap<number, MatchCutAlignment>,
): Clip[] {
  let at = 0;
  return clips.map((clip, index) => {
    const into = aligned.get(index);
    const out = aligned.get(index + 1);
    const from = into?.status === "aligned" ? into.incomingStartMs / 1000 : clip.from;
    const to = out?.status === "aligned" ? out.outgoingEndMs / 1000 : clip.to;
    const changed = from !== clip.from || to !== clip.to;
    // Never a clip of nothing: a cut point past the other end is left alone.
    const next = changed && to > from ? { ...clip, from, to, seconds: to - from } : clip;
    const placed = { ...next, at };
    at += placed.seconds;
    return placed;
  });
}

/** The transform each aligned clip is drawn with, by clip index. */
export function transformsOf(
  aligned: ReadonlyMap<number, MatchCutAlignment>,
): Map<number, MatchCutTransform> {
  return new Map(
    [...aligned]
      .filter(([, alignment]) => alignment.status === "aligned")
      .map(([index, alignment]) => [index, alignment.transform]),
  );
}

/**
 * The transform as CSS, for an element showing the whole 9:16 frame: moved in shares of
 * its own size (the transform's pixels are the 720x1280 frame's), turned and scaled about
 * its centre, as the render draws it.
 */
export function cssTransform(transform: MatchCutTransform): string {
  const x = (transform.x / OUTPUT_WIDTH) * 100;
  const y = (transform.y / OUTPUT_HEIGHT) * 100;
  return `translate(${x}%, ${y}%) rotate(${transform.rotation}deg) scale(${transform.scale})`;
}

/** Whether a transform moves anything at all. */
export const moves = (transform: MatchCutTransform) =>
  transform.x !== 0 || transform.y !== 0 || transform.scale !== 1 || transform.rotation !== 0;
