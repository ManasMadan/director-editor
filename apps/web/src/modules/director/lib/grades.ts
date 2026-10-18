/**
 * A grade as a filter: the same string is a CSS filter on the preview and a canvas filter
 * in the render (lib/stitch.ts), so what the member sees is what's saved.
 */
import type { EditorGrade } from "@repo/contracts/api";

const FILTERS: Record<EditorGrade, string> = {
  none: "none",
  "black-and-white": "grayscale(1)",
  warm: "sepia(0.25) saturate(1.2)",
  cool: "saturate(0.9) hue-rotate(12deg) brightness(1.03)",
  "high-contrast": "contrast(1.35)",
  vintage: "sepia(0.45) contrast(0.9) saturate(0.8)",
  vivid: "saturate(1.5) contrast(1.05)",
};

export const gradeFilter = (grade: EditorGrade | undefined) => FILTERS[grade ?? "none"];
