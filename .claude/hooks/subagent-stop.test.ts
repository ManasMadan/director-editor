import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type HookInput, ROOT } from "./lib";
import { subagentStop, VERDICTS, verdictOf } from "./subagent-stop";

const done = (
  agent_type: string,
  last_assistant_message: string,
  stop_hook_active = false,
): HookInput => ({
  session_id: "s",
  hook_event_name: "SubagentStop",
  cwd: ROOT,
  agent_type,
  last_assistant_message,
  stop_hook_active,
});

const contextOf = (output: unknown) =>
  (output as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
    .additionalContext;

describe("a reviewer's verdict", () => {
  it("is read from the last line, longest phrase first", () => {
    const all = ["ready", "ready after minor fixes", "not ready"];
    expect(verdictOf("Findings...\nVerdict: `not ready`", all)).toBe("not ready");
    expect(verdictOf("ready after minor fixes\n", all)).toBe("ready after minor fixes");
    expect(verdictOf("I think it's ready.\nMore to say", all)).toBeNull();
    expect(verdictOf("", all)).toBeNull();
  });

  it("lets a passing review end, and tells Claude about one that didn't pass", () => {
    expect(subagentStop(done("reviewer", "Tenancy: ok\nready"))).toBeUndefined();
    const output = subagentStop(done("boilerplate:security-reviewer", "x\nblockers found"));
    expect(contextOf(output)).toContain("security-reviewer agent's verdict is `blockers found`");
  });

  it("sends a reviewer without a verdict back once, then tells Claude", () => {
    expect(subagentStop(done("migration-reviewer", "Looks fine."))).toEqual({
      decision: "block",
      reason: expect.stringContaining("`safe to deploy`, `safe after fixes`, `unsafe`"),
    });
    expect(contextOf(subagentStop(done("migration-reviewer", "Looks fine.", true)))).toContain(
      "ended without one of these verdicts",
    );
  });

  it("names the verdicts each agent's own instructions end with", () => {
    for (const [agent, { pass, fail }] of Object.entries(VERDICTS)) {
      const text = readFileSync(join(ROOT, ".claude/agents", `${agent}.md`), "utf8");
      for (const verdict of [...pass, ...fail]) {
        expect(text).toContain(`\`${verdict}\``);
      }
    }
  });
});

describe("the verifier's report", () => {
  it("passes when every row passed, and names the rows that didn't", () => {
    const table = "| command | result | duration |\n| `bun run lint` | pass | 3 s |";
    expect(subagentStop(done("verifier", table))).toBeUndefined();
    const failing = `${table}\n| \`bun run test\` | fail | 9 s |\n| \`bun run test:e2e\` | not run | - |`;
    const context = contextOf(subagentStop(done("verifier", failing)));
    expect(context).toContain("bun run test` | fail");
    expect(context).toContain("not run");
    expect(context).not.toContain("bun run lint");
  });

  it("sends a report without the table back", () => {
    expect(subagentStop(done("verifier", "All good!"))).toMatchObject({ decision: "block" });
  });
});

it("leaves other agents alone", () => {
  expect(subagentStop(done("Explore", "whatever"))).toBeUndefined();
  expect(
    subagentStop({ session_id: "s", hook_event_name: "SubagentStop", cwd: ROOT }),
  ).toBeUndefined();
});
