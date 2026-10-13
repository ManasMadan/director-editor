/** Whose voice a take records: the member's own, or none while the original's audio plays. */
import type { ShotPlan } from "@repo/contracts/api";

export type AudioMode = "voice" | "original";

const audioModes: readonly AudioMode[] = ["voice", "original"];

/** Whether the member gets the choice: only a short with speech has something to say. */
export const offersVoice = (plan: ShotPlan) =>
  plan.audio === "speech" || plan.audio === "speech-and-music";

/** The mode a plan starts in: speak when there's speech, otherwise follow the original. */
export const defaultAudio = (plan: ShotPlan): AudioMode =>
  offersVoice(plan) ? "voice" : "original";

export function parseAudio(value: string | undefined, plan: ShotPlan): AudioMode {
  const mode = audioModes.find((candidate) => candidate === value);
  return mode && (mode === "original" || offersVoice(plan)) ? mode : defaultAudio(plan);
}
