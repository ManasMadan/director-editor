import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { bashGuard } from "./bash-guard";
import { guardFiles } from "./guard-files";
import { type HookInput, ROOT } from "./lib";

const event = (tool_input: HookInput["tool_input"], cwd = ROOT): HookInput => ({
  session_id: "s",
  hook_event_name: "PreToolUse",
  cwd,
  tool_input,
});
const decision = (output: Record<string, unknown> | undefined) =>
  (output?.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision ??
  "allow";
const shipped = () => true;
const unshipped = () => false;

describe("the Bash guard", () => {
  const guard = async (command: unknown, isShipped = unshipped, cwd = ROOT) =>
    decision(await bashGuard(event({ command } as HookInput["tool_input"], cwd), isShipped));

  it.each([
    ["ls -la", "allow"],
    ["git push --force", "deny"],
    ["git commit -m x", "ask"],
    ["echo x > .env", "deny"],
    ["sed -i 's/a/b/' .claude/hooks/lib.ts", "ask"],
    ["git status && echo x > .env", "deny"],
    ["echo x > /tmp/elsewhere.txt", "allow"],
  ])("%s: %s", async (command, expected) => {
    expect(await guard(command)).toBe(expected);
  });

  it("refuses writing a shipped migration, and allows one that hasn't shipped", async () => {
    const command = "echo x >> packages/db/prisma/migrations/1_x/migration.sql";
    expect(await guard(command, shipped)).toBe("deny");
    expect(await guard(command, unshipped)).toBe("allow");
  });

  it("reads a command's paths from its own directory", async () => {
    expect(
      await guard("rm migration_lock.toml", unshipped, join(ROOT, "packages/db/prisma/migrations")),
    ).toBe("deny");
  });

  it("names the file and the rule", async () => {
    const output = await bashGuard(event({ command: "cp new.lock bun.lock" }), unshipped);
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringMatching(/^bun\.lock: Lockfiles are written/),
      },
    });
  });

  it("lets a call without a command through", async () => {
    expect(await guard(undefined)).toBe("allow");
    expect(await guard(["ls"])).toBe("allow");
  });
});

describe("the file guard", () => {
  const guard = async (tool_input: HookInput["tool_input"], isShipped = unshipped) =>
    decision(await guardFiles(event(tool_input), isShipped));
  const path = (file: string) => join(ROOT, file);

  it("refuses secrets and generated files, and asks about the guard rails", async () => {
    expect(await guard({ file_path: path(".env") })).toBe("deny");
    expect(await guard({ file_path: path("apps/api/openapi.json") })).toBe("deny");
    expect(await guard({ file_path: path(".claude/settings.json") })).toBe("ask");
    expect(await guard({ file_path: path("apps/api/src/main.ts") })).toBe("allow");
  });

  it("looks at what an edit changes, and whether the file has shipped", async () => {
    const values = path("deploy/environments/production/stack.yaml");
    expect(await guard({ file_path: values, old_string: "tag: a", new_string: "tag: b" })).toBe(
      "deny",
    );
    expect(
      await guard({ file_path: values, old_string: "replicas: 2", new_string: "replicas: 3" }),
    ).toBe("allow");
    const migration = path("packages/db/prisma/migrations/1_x/migration.sql");
    expect(await guard({ file_path: migration }, shipped)).toBe("deny");
    expect(await guard({ file_path: migration })).toBe("allow");
  });

  it("lets a call that targets no file through", async () => {
    expect(await guardFiles(event({ command: "ls" }))).toBeUndefined();
  });
});
