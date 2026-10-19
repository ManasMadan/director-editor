/**
 * "What you'll need" on a template's page, worked out from its plan: whether the member
 * is on camera or only heard, roughly how long filming takes, the pieces Director makes
 * for them (the plan's assets), and the editing the editor applies (its edit list). The
 * words are the page's (packages/i18n), so only keys come from here.
 */
import type { ShotPlan } from "@repo/contracts/api";

type Presence = "on-camera" | "on-camera-silent" | "voice-only" | "on-camera-and-voice" | "nobody";

type EditingKey =
  | "split"
  | "pictureInPicture"
  | "wordCaptions"
  | "boxedCaptions"
  | "captions"
  | "lowerThirds"
  | "titles"
  | "blackAndWhite"
  | "grade"
  | "transitions"
  | "speed"
  | "broll"
  | "endCard";

export interface Needs {
  presence: Presence;
  /** About how long filming takes, in whole minutes: a few tries of every filmed shot. */
  minutes: number;
  /** The plan's assets, in its order: what Director makes (or finds) for the member. */
  makes: ShotPlan["assets"];
  editing: EditingKey[];
}

// A shot takes a few tries and a little setting up: about four times its length.
const TRIES_PER_SHOT = 4;
const SECONDS_PER_MINUTE = 60;

/**
 * Who's in the video. A shot the member films ("on-camera" mode) isn't always one of
 * them talking: one with no line is them without a word, and one with no one in it (no
 * pose's joints: hands and a mug, the view) is just the things they film. A no-talking
 * brief must never read as "talking to the camera".
 */
function presenceOf(plan: ShotPlan): Presence {
  const filmed = plan.shots.filter((shot) => shot.mode === "on-camera");
  const voice = plan.shots.some((shot) => shot.mode === "voice-over");
  if (filmed.length === 0) {
    return voice ? "voice-only" : "nobody";
  }
  if (voice) {
    return "on-camera-and-voice";
  }
  if (filmed.some((shot) => shot.script.length > 0)) {
    return "on-camera";
  }
  return filmed.some((shot) => shot.pose.keypoints.length > 0) ? "on-camera-silent" : "nobody";
}

type Edit = ShotPlan["edits"][number];

const LAYOUTS: Record<Extract<Edit, { type: "layout" }>["layout"], EditingKey | null> = {
  full: null,
  split: "split",
  "picture-in-picture": "pictureInPicture",
};
const CAPTIONS: Record<"word-by-word" | "boxed" | "line", EditingKey> = {
  "word-by-word": "wordCaptions",
  boxed: "boxedCaptions",
  line: "captions",
};

function textOf(edit: Extract<Edit, { type: "text" }>): EditingKey {
  if (edit.style === "captions") {
    return CAPTIONS[edit.captionStyle ?? "line"];
  }
  return edit.style === "lower-third" ? "lowerThirds" : "titles";
}

function editingOf(edit: Edit): EditingKey | null {
  switch (edit.type) {
    case "layout":
      return LAYOUTS[edit.layout];
    case "text":
      return textOf(edit);
    case "grade":
      return edit.grade === "black-and-white" ? "blackAndWhite" : "grade";
    case "transition":
      return edit.transition === "cut" ? null : "transitions";
    case "speed":
      return "speed";
    case "gap":
      return "broll";
    case "end-card":
      return "endCard";
    case "overlay":
      return null;
  }
}

export function needsOf(plan: ShotPlan): Needs {
  const filmed = plan.shots.filter((shot) => shot.mode !== "asset");
  const seconds = filmed.reduce((total, shot) => total + shot.durationSeconds, 0);
  const editing = new Set<EditingKey>();
  for (const edit of plan.edits) {
    const key = editingOf(edit);
    if (key) {
      editing.add(key);
    }
  }
  return {
    presence: presenceOf(plan),
    minutes: Math.max(1, Math.ceil((seconds * TRIES_PER_SHOT) / SECONDS_PER_MINUTE)),
    makes: plan.assets,
    editing: [...editing],
  };
}
