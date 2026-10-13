/**
 * PreToolUse (Edit|Write|MultiEdit|NotebookEdit): refuse edits that would be lost or
 * dangerous, and ask the user about changes to Claude's own guard rails (file-rules.ts).
 * It fails closed: an event it can't read blocks the edit. Runs in well under 100ms.
 */

import { runMain } from "../../scripts/lib";
import { verdictFor } from "./file-rules";
import {
  defaultBranch,
  editedText,
  type HookInput,
  type HookOutput,
  hookMain,
  isShipped,
  targetPath,
} from "./lib";

/** The decision on an edit, or nothing when it's allowed. */
export async function guardFiles(input: HookInput, shipped = isShipped): Promise<HookOutput> {
  const path = targetPath(input);
  if (!path) {
    return;
  }
  const verdict = verdictFor({
    path,
    shipped: shipped(await defaultBranch(), path),
    ...editedText(input),
  });
  if (!verdict) {
    return;
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: verdict.decision,
      permissionDecisionReason: verdict.reason,
    },
  };
}

await runMain(import.meta, hookMain(guardFiles, { failClosed: true }));
