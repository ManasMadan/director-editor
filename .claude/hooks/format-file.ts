/**
 * PostToolUse (Edit|Write|MultiEdit): format the one file just edited and apply the safe
 * lint fixes, then tell Claude about any lint error that's left, so a problem is seen at
 * the edit rather than at the end of the turn. Type-checking is left to the Stop hook:
 * running tsc on every edit flaps mid-refactor and costs seconds each time.
 */

import { runMain } from "../../scripts/lib";
import { type HookInput, type HookOutput, hookMain, ROOT, shell, targetPath } from "./lib";

/** Formats the edited file; what lint still reports, or nothing. */
export async function formatFile(input: HookInput, run = shell): Promise<HookOutput> {
  const file = targetPath(input);
  if (!file) {
    return;
  }

  /**
   * Runs the fixers quietly, then the check whose output (if it fails) Claude should see.
   * Commands run from the repository root unless they give their own directory.
   */
  async function fixThenCheck(fix: string[][], check?: string[], cwd = ROOT) {
    for (const command of fix) {
      await run(command, cwd);
    }
    if (!check) {
      return "";
    }
    const result = await run(check, cwd);
    return result.exitCode === 0 ? "" : `${result.stdout}${result.stderr}`.trim();
  }

  let remaining = "";
  if (/\.(ts|tsx|js|mjs|cjs|json|jsonc|css)$/.test(file)) {
    const flags = ["--no-errors-on-unmatched", "--files-ignore-unknown=true"];
    remaining = await fixThenCheck(
      [["bunx", "biome", "check", "--write", ...flags, file]],
      ["bunx", "biome", "check", ...flags, "--colors=off", file],
    );
  } else if (file.endsWith(".py")) {
    const ruff = ["uv", "run", "--project", "apps/ai", "ruff"];
    remaining = await fixThenCheck(
      [
        [...ruff, "check", "--fix", "--quiet", file],
        [...ruff, "format", "--quiet", file],
      ],
      [...ruff, "check", "--output-format=concise", file],
    );
  } else if (file.endsWith(".prisma")) {
    // The schema is a folder, formatted as a whole, from its package (prisma.config.ts).
    await fixThenCheck([["bunx", "prisma", "format"]], undefined, `${ROOT}/packages/db`);
  } else if (/\.(tf|tfvars|hcl)$/.test(file) && !file.endsWith(".lock.hcl")) {
    await fixThenCheck([["tofu", "fmt", file]]);
  }

  if (!remaining) {
    return;
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `Lint errors left in ${file} after the automatic fixes; fix them now:\n${remaining.split("\n").slice(-30).join("\n")}`,
    },
  };
}

await runMain(import.meta, hookMain(formatFile));
