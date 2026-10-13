/**
 * PreToolUse (Bash): the same file rules as guard-files.ts for files a command writes
 * (sed -i, redirects, tee, cp, mv, rm, ...), and the command policy: no skipped hooks,
 * no force pushes or decrypted secrets, and the user's say-so for commits, pushes,
 * GitHub changes, infrastructure and destructive scripts (shell.ts). Fails closed.
 */
import { isAbsolute, join, relative } from "node:path";
import { runMain } from "../../scripts/lib";
import { verdictFor } from "./file-rules";
import { defaultBranch, type HookInput, type HookOutput, hookMain, isShipped, ROOT } from "./lib";
import { commandPolicy, writeTargets } from "./shell";

const decide = (decision: "deny" | "ask", reason: string): HookOutput => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: decision,
    permissionDecisionReason: reason,
  },
});

/** The decision on a Bash call, or nothing when it's allowed. */
export async function bashGuard(input: HookInput, shipped = isShipped): Promise<HookOutput> {
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  if (!command) {
    return;
  }

  const policy = commandPolicy(command);
  if (policy?.decision === "deny") {
    return decide("deny", policy.reason);
  }

  const branch = await defaultBranch();
  const cwd = input.cwd || ROOT;
  for (const target of writeTargets(command)) {
    const path = relative(ROOT, isAbsolute(target) ? target : join(cwd, target));
    if (path.startsWith("..")) {
      continue;
    }
    // A shell write replaces content the hook can't see, so image tags count as touched.
    const verdict = verdictFor({ path, shipped: shipped(branch, path), after: "tag:" });
    if (verdict) {
      return decide(verdict.decision, `${path}: ${verdict.reason}`);
    }
  }
  return policy ? decide(policy.decision, policy.reason) : undefined;
}

await runMain(import.meta, hookMain(bashGuard, { failClosed: true }));
