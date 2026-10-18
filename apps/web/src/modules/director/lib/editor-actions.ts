/**
 * The conversational editor's edits, applied in the browser. Director answers a request
 * (contracts editor.ts) with actions; `applyActions` turns them into the next editor
 * choices, which the edit history pushes as one step, so a request that changes six
 * shots is undone with one tap. What only the page can do (undo, redo, reshooting a
 * shot, opening an asset's options) comes back as effects for the page to carry out.
 *
 * Other editor features join here: a new action is one entry in `APPLY` (and in the
 * contract's `editorOps`), and the asset picker takes the `asset` effect.
 */
import {
  type EditorAction,
  type EditorGrade,
  type EditorState,
  editorGrades,
} from "@repo/contracts/api";
import type { DirectorTakeId } from "@repo/contracts/ids";
import { type CaptionLine, type CaptionStyle, captionStyles } from "./captions";
import type { Clip } from "./edit";
import type { Picks } from "./picks";

/** The part of a take played, in seconds from its start. */
interface Trim {
  from: number;
  to: number;
}

/** A word the captions show differently: "cloud" shown as "Claude". */
export interface CaptionFix {
  text: string;
  replacement: string;
}

/** What the member decides in the editor, all of it undoable. */
export interface EditorChoices {
  style: CaptionStyle;
  /** Whether the takes' own sound goes into the video. */
  sound: boolean;
  /** The takes the member picked over Director's, by shot (lib/picks.ts). */
  picks: Picks;
  /** Shot indexes in the order they play; null keeps the plan's order. */
  order: readonly number[] | null;
  /** Shots left out (their takes are kept). */
  dropped: readonly number[];
  /** In and out points changed from what Gemini kept, by shot. */
  trims: Readonly<Record<number, Trim>>;
  grades: Readonly<Record<number, EditorGrade>>;
  fixes: readonly CaptionFix[];
}

export const UNARRANGED = {
  order: null,
  dropped: [],
  trims: {},
  grades: {},
  fixes: [],
} satisfies Partial<EditorChoices>;

export type EditorEffect =
  | { kind: "undo" | "redo"; steps: number }
  | { kind: "reshoot"; shotIndex: number }
  | { kind: "asset"; request: string }
  | { kind: "music"; level: number };

/** The shortest a trimmed clip may play, in seconds. */
const MIN_CLIP_SECONDS = 0.5;
/** The longest a take can be, in seconds (the contract's limit on in and out points). */
const TAKE_MAX_SECONDS = 60;

/**
 * The shots that play, in order: the member's order of the shots there are (`all`, by
 * shot index; a shot their version skips isn't one), without the dropped ones.
 */
export function playOrder(choices: EditorChoices, all: readonly number[]): number[] {
  const chosen = (choices.order ?? all).filter((index) => all.includes(index));
  const missing = all.filter((index) => !chosen.includes(index));
  return [...chosen, ...missing].filter((index) => !choices.dropped.includes(index));
}

function trimmed(clip: Clip, trim: Trim | undefined): Clip {
  if (!trim || clip.shot.kind !== "video" || clip.state !== "cut") {
    return clip;
  }
  return { ...clip, from: trim.from, to: trim.to, seconds: trim.to - trim.from };
}

/** The clips with the member's trims and grades, in their order, laid end to end again. */
export function arrange(clips: readonly Clip[], choices: EditorChoices): Clip[] {
  let at = 0;
  return playOrder(choices, indexesOf(clips)).flatMap((index) => {
    const clip = clipOf(clips, index);
    if (!clip) {
      return [];
    }
    const grade = choices.grades[index];
    const placed = { ...trimmed(clip, choices.trims[index]), at, ...(grade ? { grade } : {}) };
    at += placed.seconds;
    return [placed];
  });
}

const indexesOf = (clips: readonly Clip[]) => clips.map((clip) => clip.index);
const clipOf = (clips: readonly Clip[], shotIndex: number) =>
  clips.find((clip) => clip.index === shotIndex);

const literally = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The caption lines with the member's spelling fixes, whole words, any case. */
export function fixLines(lines: readonly CaptionLine[], fixes: readonly CaptionFix[]) {
  if (fixes.length === 0) {
    return [...lines];
  }
  return lines.map((line) => ({
    ...line,
    text: fixes.reduce(
      (text, fix) =>
        text.replaceAll(new RegExp(`\\b${literally(fix.text)}\\b`, "gi"), fix.replacement),
      line.text,
    ),
  }));
}

const clampSeconds = (seconds: number) => Math.min(TAKE_MAX_SECONDS, Math.max(0, seconds));

/** The edit as Director reads it with a request. */
export function editorState(
  clips: readonly Clip[],
  choices: EditorChoices,
  music: boolean,
): EditorState {
  const order = playOrder(choices, indexesOf(clips));
  return {
    shots: clips.map((clip) => {
      const { from, to } = trimmed(clip, choices.trims[clip.index]);
      const position = order.indexOf(clip.index);
      return {
        shotIndex: clip.index,
        takeId: clip.take?.id ?? null,
        startSeconds: clampSeconds(from),
        endSeconds: clampSeconds(to),
        position: position === -1 ? null : position,
        grade: choices.grades[clip.index] ?? "none",
      };
    }),
    captions: choices.style,
    sound: choices.sound,
    music,
    fixes: [...choices.fixes],
  };
}

interface Step {
  choices: EditorChoices;
  effects: EditorEffect[];
  /** The shots it changed, to outline on the board. */
  shots: number[];
}

type Apply = (step: Step, action: EditorAction, clips: readonly Clip[]) => Step;

const withChoices = (step: Step, next: Partial<EditorChoices>, shots: number[] = []): Step => ({
  ...step,
  choices: { ...step.choices, ...next },
  shots: [...step.shots, ...shots],
});

const withEffect = (step: Step, effect: EditorEffect): Step => ({
  ...step,
  effects: [...step.effects, effect],
});

function without<T>(record: Readonly<Record<number, T>>, key: number) {
  return Object.fromEntries(Object.entries(record).filter(([index]) => Number(index) !== key));
}

function pickTake(step: Step, shotIndex: number, takeId: DirectorTakeId): Step {
  const { picks, trims } = step.choices;
  // A new take plays the part its own review kept, not the last take's trim.
  return withChoices(
    step,
    { picks: { ...picks, [shotIndex]: takeId }, trims: without(trims, shotIndex) },
    [shotIndex],
  );
}

/** The choices with `takeId` picked for the shot, as a tap on the board picks it. */
export const withPick = (choices: EditorChoices, shotIndex: number, takeId: DirectorTakeId) =>
  pickTake({ choices, effects: [], shots: [] }, shotIndex, takeId).choices;

function trim(step: Step, action: EditorAction, clips: readonly Clip[]): Step {
  const shotIndex = action.shotIndex;
  const clip = shotIndex === null ? undefined : clipOf(clips, shotIndex);
  if (shotIndex === null || !clip || clip.shot.kind !== "video") {
    return step;
  }
  const now = step.choices.trims[shotIndex] ?? { from: clip.from, to: clip.to };
  const from = clampSeconds(action.startSeconds ?? now.from);
  const to = clampSeconds(action.endSeconds ?? now.to);
  if (to - from < MIN_CLIP_SECONDS) {
    return step;
  }
  return withChoices(step, { trims: { ...step.choices.trims, [shotIndex]: { from, to } } }, [
    shotIndex,
  ]);
}

function move(step: Step, shotIndex: number, position: number, all: readonly number[]): Step {
  const order = playOrder(step.choices, all).filter((index) => index !== shotIndex);
  order.splice(Math.min(Math.max(0, position), order.length), 0, shotIndex);
  return withChoices(step, { order }, [shotIndex]);
}

function swap(step: Step, first: number, second: number, all: readonly number[]): Step {
  const order = playOrder(step.choices, all);
  const a = order.indexOf(first);
  const b = order.indexOf(second);
  if (a === -1 || b === -1) {
    return step;
  }
  order[a] = second;
  order[b] = first;
  return withChoices(step, { order }, [first, second]);
}

const isGrade = (value: string | null): value is EditorGrade =>
  editorGrades.some((grade) => grade === value);
const isCaptionStyle = (value: string | null): value is CaptionStyle =>
  captionStyles.some((style) => style === value);

function grade(step: Step, action: EditorAction, clips: readonly Clip[]): Step {
  const value = action.value;
  if (!isGrade(value)) {
    return step;
  }
  const shots = action.shotIndex === null ? clips.map((clip) => clip.index) : [action.shotIndex];
  const grades = { ...step.choices.grades };
  for (const index of shots) {
    grades[index] = value;
  }
  return withChoices(step, { grades }, shots);
}

function fixCaption(step: Step, action: EditorAction): Step {
  if (!action.text || action.replacement === null) {
    return step;
  }
  const others = step.choices.fixes.filter(
    (fix) => fix.text.toLowerCase() !== action.text?.toLowerCase(),
  );
  return withChoices(step, {
    fixes: [...others, { text: action.text, replacement: action.replacement }],
  });
}

function volume(step: Step, action: EditorAction): Step {
  const level = action.level ?? 1;
  return action.value === "music"
    ? withEffect(step, { kind: "music", level })
    : withChoices(step, { sound: level > 0 });
}

const onShot =
  (
    apply: (step: Step, shotIndex: number, action: EditorAction, clips: readonly Clip[]) => Step,
  ): Apply =>
  (step, action, clips) =>
    action.shotIndex === null ? step : apply(step, action.shotIndex, action, clips);

const APPLY: Record<EditorAction["op"], Apply> = {
  pick_take: onShot((step, shotIndex, action) =>
    action.takeId === null ? step : pickTake(step, shotIndex, action.takeId),
  ),
  trim,
  move_shot: onShot((step, shotIndex, action, clips) =>
    action.position === null ? step : move(step, shotIndex, action.position, indexesOf(clips)),
  ),
  swap_shots: onShot((step, shotIndex, action, clips) =>
    action.otherShotIndex === null
      ? step
      : swap(step, shotIndex, action.otherShotIndex, indexesOf(clips)),
  ),
  drop_shot: onShot((step, shotIndex) =>
    withChoices(step, { dropped: [...step.choices.dropped, shotIndex] }),
  ),
  restore_shot: onShot((step, shotIndex) =>
    withChoices(step, { dropped: step.choices.dropped.filter((index) => index !== shotIndex) }, [
      shotIndex,
    ]),
  ),
  captions: (step, action) =>
    isCaptionStyle(action.value) ? withChoices(step, { style: action.value }) : step,
  edit_caption: fixCaption,
  set_grade: grade,
  set_volume: volume,
  asset_request: (step, action) =>
    action.value ? withEffect(step, { kind: "asset", request: action.value }) : step,
  reset_to_picks: (step) => withChoices(step, { picks: {}, trims: {} }),
  undo: (step, action) => withEffect(step, { kind: "undo", steps: action.steps ?? 1 }),
  redo: (step, action) => withEffect(step, { kind: "redo", steps: action.steps ?? 1 }),
  reshoot: onShot((step, shotIndex) => withEffect(step, { kind: "reshoot", shotIndex })),
};

/**
 * The choices after Director's actions, what the page must do besides, and the shots
 * they changed. `clips` are the shots' clips (`clip.index` is the shot's), before the
 * member's arrangement.
 */
export function applyActions(
  choices: EditorChoices,
  actions: readonly EditorAction[],
  clips: readonly Clip[],
): Step {
  return actions.reduce<Step>((step, action) => APPLY[action.op](step, action, clips), {
    choices,
    effects: [],
    shots: [],
  });
}
