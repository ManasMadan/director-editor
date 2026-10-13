/**
 * SessionEnd: removes the session's state (the tree fingerprint, the re-check count,
 * what it already asked, the hints it had), which would otherwise pile up in
 * .claude/.state.
 */

import { rmSync } from "node:fs";
import { runMain } from "../../scripts/lib";
import { type HookInput, hookMain, sessionFiles } from "./lib";

export function sessionEnd(input: HookInput) {
  for (const file of sessionFiles) {
    rmSync(file(input.session_id), { force: true });
  }
  return undefined;
}

await runMain(import.meta, hookMain(sessionEnd));
