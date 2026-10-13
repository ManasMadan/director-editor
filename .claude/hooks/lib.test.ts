import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  changedFiles,
  defaultBranch,
  editedText,
  hookMain,
  isShipped,
  ROOT,
  runHook,
  shell,
  targetPath,
  treeFingerprint,
} from "./lib";

let repo: string;
beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "hooks-"));
  await $`git init -q -b main && git config user.email t@example.com && git config user.name t`.cwd(
    repo,
  );
  writeFileSync(join(repo, "tracked.ts"), "// one\n");
  await $`git add . && git commit -qm init`.cwd(repo);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("the working tree's fingerprint", () => {
  it("changes when an already changed line changes again", async () => {
    writeFileSync(join(repo, "tracked.ts"), "// two\n");
    const before = await treeFingerprint(repo);
    writeFileSync(join(repo, "tracked.ts"), "// six\n");
    expect(await treeFingerprint(repo)).not.toBe(before);
  });

  it("changes when an untracked file is rewritten", async () => {
    writeFileSync(join(repo, "new.ts"), "export const a = 1;\n");
    const before = await treeFingerprint(repo);
    writeFileSync(join(repo, "new.ts"), "export const a: string = 1;\n");
    expect(await treeFingerprint(repo)).not.toBe(before);
  });

  it("stays the same when nothing changed", async () => {
    expect(await treeFingerprint(repo)).toBe(await treeFingerprint(repo));
  });
});

describe("changed files", () => {
  it("lists edits and new files, not deletions", async () => {
    writeFileSync(join(repo, "tracked.ts"), "// two\n");
    writeFileSync(join(repo, "new.ts"), "\n");
    expect(await changedFiles(repo)).toEqual(["new.ts", "tracked.ts"]);
    rmSync(join(repo, "tracked.ts"));
    expect(await changedFiles(repo)).toEqual(["new.ts"]);
  });
});

describe("the default branch", () => {
  it("is origin's HEAD, or master without a remote", async () => {
    expect(await defaultBranch(repo)).toBe("master");
    await $`git update-ref refs/remotes/origin/main HEAD && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main`.cwd(
      repo,
    );
    expect(await defaultBranch(repo)).toBe("main");
  });
});

describe("running a hook", () => {
  const streams = (event: string) => {
    const written = { stdout: "", stderr: "" };
    return {
      written,
      stdin: { text: async () => event },
      stdout: { write: (text: string) => (written.stdout += text) },
      stderr: { write: (text: string) => (written.stderr += text) },
    };
  };

  it("hands the event to the handler and writes its answer as JSON", async () => {
    const io = streams('{"session_id":"s","tool_name":"Bash"}');
    const code = await runHook((input) => ({ seen: input.tool_name }), io);
    expect(code).toBe(0);
    expect(io.written.stdout).toBe('{"seen":"Bash"}');
  });

  it("runs as a hook's entry point, with the options it's given", async () => {
    const io = streams('{"tool_name":"Edit"}');
    expect(await hookMain((input) => ({ seen: input.tool_name }), io)()).toBe(0);
    expect(io.written.stdout).toBe('{"seen":"Edit"}');
  });

  it("writes nothing when the handler has nothing to say", async () => {
    const io = streams("{}");
    expect(await runHook(async () => undefined, io)).toBe(0);
    expect(io.written).toEqual({ stdout: "", stderr: "" });
  });

  it("blocks the call when a guard can't read its event, and fails otherwise", async () => {
    const io = streams("not json");
    expect(await runHook(() => undefined, { ...io, failClosed: true })).toBe(2);
    expect(io.written.stderr).toContain("The hook couldn't read its event, so the call is blocked");
    await expect(runHook(() => undefined, streams("not json"))).rejects.toThrow(SyntaxError);
  });
});

describe("what a tool call edits", () => {
  it("reads an Edit's old and new text, a MultiEdit's edits and a Write's content", () => {
    const edit = { session_id: "s", hook_event_name: "PreToolUse", cwd: ROOT };
    expect(editedText({ ...edit, tool_input: { old_string: "a", new_string: "b" } })).toEqual({
      before: "a",
      after: "b",
    });
    const edits = [
      { old_string: "a", new_string: "b" },
      { old_string: "c", new_string: "d" },
    ];
    expect(editedText({ ...edit, tool_input: { edits } })).toEqual({
      before: "a\nc",
      after: "b\nd",
    });
    expect(editedText({ ...edit, tool_input: { content: "all" } })).toEqual({
      before: undefined,
      after: "all",
    });
    expect(editedText(edit)).toEqual({ before: undefined, after: undefined });
  });

  it("names the targeted file relative to the repository", () => {
    const call = { session_id: "s", hook_event_name: "PreToolUse", cwd: ROOT };
    expect(targetPath({ ...call, tool_input: { file_path: join(ROOT, "apps/x.ts") } })).toBe(
      "apps/x.ts",
    );
    expect(targetPath({ ...call, tool_input: { notebook_path: join(ROOT, "n.ipynb") } })).toBe(
      "n.ipynb",
    );
    expect(targetPath({ ...call, tool_input: { command: "ls" } })).toBeNull();
  });
});

describe("whether a file has shipped", () => {
  it("is whether the branch has it", () => {
    expect(isShipped("main", "tracked.ts", repo)).toBe(true);
    expect(isShipped("main", "new.ts", repo)).toBe(false);
  });
});

describe("running a command quietly", () => {
  it("returns its exit code and output, whatever the code", async () => {
    const script = "console.log('out'); console.error('err'); process.exit(4)";
    expect(await shell(["bun", "-e", script], repo)).toEqual({
      exitCode: 4,
      stdout: "out\n",
      stderr: "err\n",
    });
  });
});
