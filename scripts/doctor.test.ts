import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "./doctor";
import type { Ran } from "./lib";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

const ROOT = join(import.meta.dir, "..");
// The major version: .nvmrc pins the exact one CI uses.
const node = readFileSync(join(ROOT, ".nvmrc"), "utf8").trim().split(".")[0];
const pinnedBun = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { packageManager: string }
).packageManager.replace(/^bun@/, "");

let dir: string;
let examplePath: string;
let envPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "doctor-"));
  examplePath = join(dir, ".env.example");
  envPath = join(dir, ".env");
  writeFileSync(examplePath, "A=1\nSECRET=change-me\n");
});

const healthy = "postgres healthy running\nvalkey healthy running\nmailpit  running\n";
/** What each tool prints for `--version` on a machine that has it. */
const versions: Record<string, string> = {
  "node --version": `v${node}.1.0\n`,
  "uv --version": "uv 0.12.0\n",
  "wt --version": "wt 0.57.0\n",
  "typescript-language-server --version": "5.1.3\n",
  "pyright --version": "pyright 1.1.414\n",
};

/** A machine with every tool, services as `ps` says, and some answers overridden. */
function machine(answers: Record<string, Partial<Ran>> = {}, ps = healthy) {
  return fakeRun((line) => {
    if (line in answers) {
      return answers[line];
    }
    if (line in versions) {
      return { stdout: versions[line] };
    }
    if (line.startsWith("docker info")) {
      return { stdout: "29.0.0\n" };
    }
    if (line.startsWith("docker compose ps")) {
      return { stdout: ps };
    }
    if (line.startsWith("docker compose exec")) {
      return { stdout: "6\n" };
    }
    return {};
  }).run;
}

describe("doctor", () => {
  it("passes a machine with the tools, a complete .env and the services up", () => {
    const printed = captureOutput();
    writeFileSync(envPath, "A=2\nSECRET=s3cret\n");
    expect(doctor({ run: machine(), envPath, examplePath, bunVersion: pinnedBun })).toBe(0);
    const output = printed();
    expect(output).toContain(`Node v${node}.1.0`);
    expect(output).toContain(`Bun ${pinnedBun}`);
    expect(output).toContain("uv 0.12.0");
    expect(output).toContain("wt 0.57.0");
    expect(output).toContain("typescript-language-server and pyright, for Claude Code");
    expect(output).toContain("Docker 29.0.0");
    expect(output).toContain("2 variables, in sync with .env.example");
    expect(output).toContain("mailpit running");
    expect(output).toContain("database roles bootstrapped");
    expect(output).toContain("All good.");
  });

  it("names every missing tool, and a missing .env, with how to fix it", () => {
    const printed = captureOutput();
    const run = fakeRun(() => ({ status: null })).run;
    expect(doctor({ run, envPath, examplePath, bunVersion: "1.0.0" })).toBe(1);
    const output = printed();
    expect(output).toContain("Node is not installed");
    expect(output).toContain("Bun 1.0.0 found");
    expect(output).toContain("uv is not installed");
    expect(output).toContain("Worktrunk isn't installed (optional");
    expect(output).toContain(
      "needs typescript-language-server and pyright (optional): `bun add -g typescript-language-server pyright`.",
    );
    expect(output).toContain("Docker is not running");
    expect(output).toContain("No .env yet. Run `bun run setup`.");
    expect(output).not.toContain("Local services");
    expect(output).toContain("5 problem(s) found.");
  });

  it("names drift in .env, the wrong Node, and services that aren't up", () => {
    const printed = captureOutput();
    writeFileSync(envPath, "SECRET=change-me\nOLD=1\nCOMPOSE_PROJECT_NAME=app-stack1\n");
    const run = machine(
      { "node --version": { stdout: "v12.0.0\n" } },
      "postgres healthy running\nvalkey  exited\n",
    );
    const roles = machine(
      { "node --version": { stdout: "v12.0.0\n" } },
      "postgres starting running\n",
    );
    expect(doctor({ run, envPath, examplePath, bunVersion: "1.3.999" })).toBe(1);
    const output = printed();
    expect(output).toContain(`Node v12.0.0 found, ${node} expected`);
    expect(output).toContain(`Bun 1.3.999; CI and the images use ${pinnedBun}`);
    expect(output).toContain("Missing in .env: A.");
    expect(output).toContain(
      "In .env but not in .env.example (renamed or removed?): OLD. Remove them with `bun run env:unset OLD`.",
    );
    expect(output).toContain("Still set to a placeholder: SECRET.");
    expect(output).toContain("valkey is not running");
    expect(output).toContain("mailpit is not running");
    expect(doctor({ run: roles, envPath, examplePath, bunVersion: pinnedBun })).toBe(1);
  });

  it("finds a database volume made before the roles existed", () => {
    const printed = captureOutput();
    writeFileSync(envPath, "A=2\nSECRET=s3cret\nEXTRA=1\n");
    const roles =
      "docker compose exec -T postgres psql -U postgres -d app -Atc select count(*) from pg_roles where rolname in ('migrator','app_api','app_worker','app_notifications','app_webhooks','app_ai')";
    const run = machine({ [roles]: { stdout: "2\n" } });
    expect(doctor({ run, envPath, examplePath, bunVersion: pinnedBun })).toBe(1);
    expect(printed()).toContain("Database roles are missing");
    expect(printed()).toContain("3 variables, in sync with .env.example");
  });
});
