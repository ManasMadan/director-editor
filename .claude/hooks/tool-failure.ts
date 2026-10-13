/**
 * PostToolUseFailure (Bash): when one of the repo's own commands fails (tests, builds,
 * services, migrations), points Claude at the debug skill and the doctor, once a
 * session, instead of guessing at the cause or retrying blindly. Other failures (a grep
 * that found nothing) say nothing.
 */
import { existsSync } from "node:fs";
import { runMain } from "../../scripts/lib";
import { type HookInput, type HookOutput, hintedFile, hookMain } from "./lib";

const REPO_COMMAND =
  /^\s*(bun (run|test|scripts\/)|bunx (turbo|vitest|playwright|prisma|tsc)|turbo |docker compose |uv run )/;

/** The hint for a failed repo command, once a session; nothing otherwise. */
export async function toolFailure(input: HookInput): Promise<HookOutput> {
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  const hinted = hintedFile(input.session_id);
  if (!REPO_COMMAND.test(command) || existsSync(hinted)) {
    return;
  }
  await Bun.write(hinted, "");
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUseFailure",
      additionalContext:
        "A repo command failed. Read the failure first; if the cause isn't in it, follow the debug skill (logs, request ids, the services) and run `bun run doctor` for the machine itself, rather than retrying or changing code to get past it.",
    },
  };
}

await runMain(import.meta, hookMain(toolFailure));
