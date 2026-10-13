/**
 * PostToolUse (Edit|Write|MultiEdit): refuses a new suppression, skipped or focused test,
 * coverage pragma or rule turned off (scripts/suppressions.ts), unless a row of
 * docs/testing.md's exceptions tables allows that kind in that file. The edit has
 * happened, so Claude is told to undo it.
 */
import { spawnSync } from "node:child_process";
import { runMain } from "../../scripts/lib";
import {
  addedSuppressions,
  CODE,
  DEFINES_THEM,
  exceptionRows,
  unallowed,
} from "../../scripts/suppressions";
import { editedText, type HookInput, type HookOutput, hookMain, ROOT, targetPath } from "./lib";

/** Blocks an edit that adds an unlisted suppression; nothing otherwise. */
export function suppressions(input: HookInput): HookOutput {
  const path = targetPath(input);
  if (!path || !CODE.test(path) || DEFINES_THEM.has(path)) {
    return;
  }

  const edit = editedText(input);
  // A whole-file write replaces what the last commit had.
  const before =
    input.tool_name === "Write"
      ? spawnSync("git", ["show", `HEAD:${path}`], { cwd: ROOT, encoding: "utf8" }).stdout
      : (edit.before ?? "");
  const after = edit.after ?? "";
  const added = addedSuppressions(before, after, path);
  const refused = unallowed(exceptionRows(ROOT), path, after).filter((kind) =>
    added.includes(kind),
  );
  if (refused.length === 0) {
    return;
  }
  return {
    decision: "block",
    reason: `${path} now has ${refused.join(", ")}. Fix the cause instead and remove it. If it truly can't be fixed, the user decides: it's allowed only with a row in docs/testing.md's exceptions tables (the reason, and the test that covers the behaviour another way).`,
  };
}

await runMain(import.meta, hookMain(suppressions));
