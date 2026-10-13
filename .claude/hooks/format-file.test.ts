import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { formatFile } from "./format-file";
import { type HookInput, ROOT } from "./lib";

/** A stand-in for the formatters: records each command, and fails the checks `failing` names. */
function formatters(failing = "") {
  const ran: string[] = [];
  const run = async (command: string[], cwd = ROOT) => {
    const line = `${cwd === ROOT ? "" : `(${cwd}) `}${command.join(" ")}`;
    ran.push(line);
    const fails = failing !== "" && line.includes(failing);
    return { exitCode: fails ? 1 : 0, stdout: fails ? "x.ts:1 lint/style\n" : "", stderr: "" };
  };
  return { run, ran };
}

const edited = (file: string): HookInput => ({
  session_id: "s",
  hook_event_name: "PostToolUse",
  cwd: ROOT,
  tool_input: { file_path: join(ROOT, file) },
});

describe("formatting the edited file", () => {
  it("fixes TypeScript with Biome, and tells Claude what's left", async () => {
    const { run, ran } = formatters("--colors=off");
    const output = await formatFile(edited("apps/api/src/x.ts"), run);
    expect(ran).toEqual([
      "bunx biome check --write --no-errors-on-unmatched --files-ignore-unknown=true apps/api/src/x.ts",
      "bunx biome check --no-errors-on-unmatched --files-ignore-unknown=true --colors=off apps/api/src/x.ts",
    ]);
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: expect.stringContaining("Lint errors left in apps/api/src/x.ts"),
      },
    });
  });

  it("says nothing when the fixes leave no error", async () => {
    expect(await formatFile(edited("apps/web/src/x.css"), formatters().run)).toBeUndefined();
  });

  it("fixes and formats Python with ruff", async () => {
    const { run, ran } = formatters();
    await formatFile(edited("apps/ai/app/x.py"), run);
    expect(ran).toEqual([
      "uv run --project apps/ai ruff check --fix --quiet apps/ai/app/x.py",
      "uv run --project apps/ai ruff format --quiet apps/ai/app/x.py",
      "uv run --project apps/ai ruff check --output-format=concise apps/ai/app/x.py",
    ]);
  });

  it("formats the whole Prisma schema from its package, and OpenTofu files", async () => {
    const { run, ran } = formatters();
    await formatFile(edited("packages/db/prisma/schema/user.prisma"), run);
    await formatFile(edited("infra/tofu/main.tf"), run);
    await formatFile(edited("infra/tofu/.terraform.lock.hcl"), run);
    await formatFile(edited("docs/testing.md"), run);
    expect(ran).toEqual([
      `(${ROOT}/packages/db) bunx prisma format`,
      "tofu fmt infra/tofu/main.tf",
    ]);
  });

  it("does nothing for a call without a file", async () => {
    const { run, ran } = formatters();
    expect(await formatFile({ ...edited("x.ts"), tool_input: {} }, run)).toBeUndefined();
    expect(ran).toEqual([]);
  });
});
