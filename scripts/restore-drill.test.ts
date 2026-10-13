import { afterEach, describe, expect, it, mock } from "bun:test";
import { restoreDrill } from "./restore-drill";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

const facts = ["table public.todo rows=2 hash=9 rls=true forced=true", "extension citext 1.6"];

/** Postgres as the drill sees it: `restored` is what the scratch database's fingerprint says. */
function postgres(restored: string[], fails: (line: string) => boolean = () => false) {
  return fakeRun((line) => {
    if (fails(line)) {
      return { status: 1, stderr: "server closed the connection" };
    }
    if (!line.includes("psql")) {
      return {};
    }
    return { stdout: `${(line.includes("-d app_restore_drill") ? restored : facts).join("\n")}\n` };
  });
}

describe("the restore drill", () => {
  it("passes when the restore matches the source, and removes the scratch copy", () => {
    const printed = captureOutput();
    const { run, calls } = postgres(facts);
    expect(restoreDrill("app", undefined, run)).toBe(0);
    expect(printed()).toContain("identical: 1 tables");
    expect(calls.map((line) => line.split(" ").slice(0, 6).join(" "))).toEqual([
      "docker compose exec -T postgres dropdb",
      "docker compose exec -T postgres rm",
      "docker compose exec -T postgres psql",
      "docker compose exec -T postgres pg_dump",
      "docker compose exec -T postgres createdb",
      "docker compose exec -T postgres pg_restore",
      "docker compose exec -T postgres psql",
      "docker compose exec -T postgres dropdb",
      "docker compose exec -T postgres rm",
    ]);
  });

  it("fails and shows each difference when the restore lost or gained something", () => {
    const printed = captureOutput();
    const { run } = postgres([facts[0] as string, "extension citext 1.5"]);
    expect(restoreDrill("app", "ci-postgres", run)).toBe(1);
    expect(printed()).toContain("the restore differs from the source");
    expect(printed()).toContain("    - extension citext 1.6");
    expect(printed()).toContain("    + extension citext 1.5");
  });

  it("runs in the given container, and fails with the step that broke", () => {
    const printed = captureOutput();
    const { run, calls } = postgres(facts, (line) => line.includes("pg_dump"));
    expect(restoreDrill("other", "ci-postgres", run)).toBe(1);
    expect(calls[0]).toStartWith("docker exec -i ci-postgres dropdb");
    expect(printed()).toContain("failed:\nserver closed the connection");
    // It still cleans up after the failure.
    expect(calls.at(-2)).toContain("dropdb -U postgres --if-exists --force other_restore_drill");
  });

  it("fails when the scratch copy can't be removed afterwards", () => {
    const printed = captureOutput();
    let drops = 0;
    const { run } = postgres(facts, (line) => line.includes("dropdb") && ++drops === 2);
    expect(restoreDrill("app", undefined, run)).toBe(1);
    expect(printed()).toContain("couldn't remove app_restore_drill");
  });
});
