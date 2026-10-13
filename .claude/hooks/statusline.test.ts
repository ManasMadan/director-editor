import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { printStatusline, servicePorts, statusline } from "./statusline";

let repo: string;
let server: Server;
let port: number;
beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "statusline-"));
  await $`git init -q -b feature && git config user.email t@example.com && git config user.name t`.cwd(
    repo,
  );
  await $`git commit -q --allow-empty -m init`.cwd(repo);
  server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  port = (server.address() as { port: number }).port;
});
afterEach(() => {
  server.close();
  rmSync(repo, { recursive: true, force: true });
});

const stdin = (value: unknown) => ({
  json: async () => (value instanceof Error ? Promise.reject(value) : value),
});

describe("the status line", () => {
  it("shows the branch, the uncommitted changes and which services are up", async () => {
    writeFileSync(join(repo, "a.ts"), "");
    writeFileSync(join(repo, "b.ts"), "");
    const services = [
      { name: "pg", port },
      { name: "valkey", port: 1 },
    ];
    expect(await statusline(stdin({ workspace: { project_dir: repo } }), services)).toBe(
      "feature +2 | pg up valkey down",
    );
  });

  it("says so outside git, and reads no event as the current directory", async () => {
    const outside = mkdtempSync(join(tmpdir(), "no-git-"));
    expect(await statusline(stdin({ workspace: { project_dir: outside } }), [])).toBe("no git | ");
    expect(await statusline(stdin(new Error("not JSON")), [{ name: "pg", port }])).toMatch(
      / \| pg up$/,
    );
  });

  it("checks the ports .env sets, else the example's", () => {
    const env = new Map([["POSTGRES_PORT", "5432"]]);
    const example = new Map([
      ["POSTGRES_PORT", "55432"],
      ["VALKEY_PORT", "56379"],
      ["MAILPIT_SMTP_PORT", "51025"],
    ]);
    expect(servicePorts(env, example)).toEqual([
      { name: "pg", port: 5432 },
      { name: "valkey", port: 56379 },
      { name: "mail", port: 51025 },
    ]);
    // By default, this checkout's files.
    expect(servicePorts().map((service) => service.name)).toEqual(["pg", "valkey", "mail"]);
  });
});

describe("the status line command", () => {
  it("prints the status line", async () => {
    const printed: string[] = [];
    await printStatusline((text) => printed.push(text), stdin(new Error("not JSON")));
    expect(printed).toHaveLength(1);
  });
});
