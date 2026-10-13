import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { type HookInput, hintedFile, ROOT } from "./lib";
import { toolFailure } from "./tool-failure";

const sessions: string[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) {
    rmSync(hintedFile(session), { force: true });
  }
});

function failed(command?: string): HookInput {
  const session_id = `test-${crypto.randomUUID()}`;
  sessions.push(session_id);
  return {
    session_id,
    hook_event_name: "PostToolUseFailure",
    cwd: ROOT,
    tool_name: "Bash",
    tool_input: command === undefined ? {} : { command },
    error: "exit 1",
  };
}

describe("a failed command", () => {
  it("points at the debug skill once a session, for the repo's own commands", async () => {
    const input = failed("bun run test:integration");
    expect(await toolFailure(input)).toMatchObject({
      hookSpecificOutput: { additionalContext: expect.stringContaining("debug skill") },
    });
    expect(existsSync(hintedFile(input.session_id))).toBe(true);
    expect(await toolFailure(input)).toBeUndefined();
  });

  it("says nothing about other commands", async () => {
    expect(await toolFailure(failed("grep -r missing ."))).toBeUndefined();
    expect(await toolFailure(failed())).toBeUndefined();
  });
});
