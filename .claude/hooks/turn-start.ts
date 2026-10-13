/**
 * UserPromptSubmit: fingerprint the working tree's content, so the Stop hook can tell
 * whether this turn changed anything (answering a question must not trigger a
 * verification run), and start the turn's re-check count from zero.
 */

import { rmSync } from "node:fs";
import { runMain } from "../../scripts/lib";
import { type HookInput, hookMain, stopCountFile, treeFingerprint, turnFile } from "./lib";

/** Records the tree as the turn starts; answers nothing. */
export async function turnStart(input: HookInput, fingerprint = treeFingerprint) {
  await Bun.write(turnFile(input.session_id), await fingerprint());
  rmSync(stopCountFile(input.session_id), { force: true });
  return undefined;
}

await runMain(import.meta, hookMain(turnStart));
