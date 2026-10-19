/** A created plan's storyboard cards as the template's page tells them. */
import type { StoryboardState } from "@repo/contracts/api";

/** A card as the AI service reports it (only its state and why it failed matter here). */
interface Card {
  status: "pending" | "generating" | "ready" | "failed";
  error: string | null;
}

/**
 * A card with no drawing to link: still drawing, or not coming and why, so the page says
 * so instead of waiting on it. A ready card whose link storage can't sign reads as still
 * drawing.
 */
export function storyboardState({ status, error }: Card): StoryboardState {
  if (status !== "failed") {
    return "drawing";
  }
  if (error === "AI_BUDGET_EXCEEDED") {
    return "noAllowance";
  }
  return error === "DIRECTOR_IMAGE_LIMIT" ? "dailyLimit" : "failed";
}
