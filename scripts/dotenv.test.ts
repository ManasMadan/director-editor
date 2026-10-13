import { describe, expect, it } from "bun:test";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./lib";

/** What a `bun` started in a folder with this repository's bunfig.toml and a .env sees. */
function seen(args: string[]) {
  const folder = mkdtempSync(join(tmpdir(), "dotenv-"));
  copyFileSync(join(ROOT, "bunfig.toml"), join(folder, "bunfig.toml"));
  writeFileSync(join(folder, ".env"), "FROM_DOTENV=yes\n");
  const ran = Bun.spawnSync(
    ["bun", ...args, "-e", "console.log(process.env.FROM_DOTENV ?? 'unset')"],
    { cwd: folder, env: { PATH: process.env.PATH, HOME: process.env.HOME } },
  );
  return ran.stdout.toString().trim();
}

describe("a checkout's .env", () => {
  // Loaded on its own, it would reach every test and every process a script starts.
  it("is never loaded unless a script asks for it", () => {
    expect(seen([])).toBe("unset");
  });

  it("is loaded where a script asks for it by name", () => {
    expect(seen(["--env-file=.env"])).toBe("yes");
  });
});
