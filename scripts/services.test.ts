import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Ran } from "./lib";
import { services } from "./services";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

const GB = 1024 ** 3;
const config = {
  services: {
    postgres: { mem_limit: String(GB) },
    valkey: { mem_limit: GB / 2 },
    "s3-init": { mem_limit: GB / 8, restart: "no" },
  },
};

/** Docker with `total` bytes, `stats` lines of what runs, and some answers overridden. */
function docker(total: number, stats: string, answers: Record<string, Partial<Ran>> = {}) {
  return fakeRun((line) => {
    const words = line.replace(/^docker (compose (--profile \w+ )?)?/, "");
    if (words in answers) {
      return answers[words];
    }
    if (words === "config --format json") {
      return { stdout: JSON.stringify(config) };
    }
    if (words.startsWith("ps")) {
      return { stdout: "valkey\n" };
    }
    if (words.startsWith("info")) {
      return { stdout: `${total}\n` };
    }
    if (words.startsWith("stats")) {
      return { stdout: stats };
    }
    return {};
  });
}

describe("starting the local services", () => {
  it("starts what fits, then the setup steps, then reapplies the read-only role", () => {
    const printed = captureOutput();
    const { run, calls } = docker(
      4 * GB,
      "other\t1.5GiB / 8GiB\nvalkey\t100MiB / 512MiB\nodd\t-\n",
    );
    expect(services(["up"], run)).toBe(0);
    expect(printed()).toContain("postgres, s3-init fit in memory (up to 1.1 GB of 1.9 GB free)");
    expect(calls.slice(-3)).toEqual([
      "docker compose up -d --wait postgres valkey",
      "docker compose run --rm s3-init",
      expect.stringContaining("docker compose exec -T postgres psql"),
    ]);
  });

  it("only reports with check, and starts nothing", () => {
    const printed = captureOutput();
    const { run, calls } = docker(4 * GB, "", {
      "ps --format {{.Service}} --status running": { stdout: "postgres\nvalkey\ns3-init\n" },
    });
    expect(services(["check", "--mail"], run)).toBe(0);
    expect(calls[0]).toBe("docker compose --profile mail config --format json");
    expect(calls.some((line) => line.includes(" up "))).toBe(false);
    expect(printed()).toBe("");
  });

  it("starts nothing when it doesn't fit, and says what to do", () => {
    const printed = captureOutput();
    const { run, calls } = docker(GB, "other\t900MB / 2GB\n");
    expect(services(["up", "--full"], run)).toBe(1);
    expect(printed()).toContain(
      "Not starting postgres, s3-init: they may use up to 1.1 GB, and Docker has 0.0 GB to spare",
    );
    expect(printed()).toContain("FILE_SCANNER=none");
    expect(calls.some((line) => line.includes(" up "))).toBe(false);
    expect(services(["up", "--files"], run)).toBe(1);
    expect(calls).toContain("docker compose --profile files config --format json");
    expect(printed().match(/FILE_SCANNER=none/g)).toHaveLength(2);
    expect(services(["up"], run)).toBe(1);
    expect(printed()).toContain("or stop other containers");
  });

  it("stops at the first step that fails", () => {
    captureOutput();
    expect(
      services(["up"], docker(8 * GB, "", { "up -d --wait postgres valkey": { status: 3 } }).run),
    ).toBe(3);
    expect(services(["up"], docker(8 * GB, "", { "run --rm s3-init": { status: 4 } }).run)).toBe(4);
    const role =
      "exec -T postgres psql -q -U postgres -d app -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/02-readonly-role.sql";
    expect(services(["up"], docker(8 * GB, "", { [role]: { status: null } }).run)).toBe(1);
  });

  it("refuses a service without a memory limit, and a compose file it can't read", () => {
    const printed = captureOutput();
    const unlimited = JSON.stringify({ services: { mailpit: {} } });
    expect(
      services(["up"], docker(8 * GB, "", { "config --format json": { stdout: unlimited } }).run),
    ).toBe(1);
    expect(printed()).toContain(
      "every service needs a memory limit in docker-compose.yml: mailpit",
    );
    const broken = { "config --format json": { status: 1, stderr: "yaml: line 3" } };
    expect(services(["check"], docker(8 * GB, "", broken).run)).toBe(1);
    expect(printed()).toContain("yaml: line 3");
  });
});

describe("the other commands", () => {
  it("stops every profile with down", () => {
    const { run, calls } = fakeRun(() => ({ status: null }));
    expect(services(["down"], run)).toBe(1);
    expect(calls).toEqual(["docker compose --profile full down"]);
  });

  it("refuses an unknown command or flag", () => {
    const printed = captureOutput();
    expect(services(["restart"], fakeRun().run)).toBe(1);
    expect(printed()).toContain("usage: bun scripts/services.ts up");
    expect(services(["up", "--everything"], fakeRun().run)).toBe(1);
    expect(printed()).toContain("unknown flag --everything");
  });

  it("starts ClamAV without waiting for its signatures, and says so", () => {
    const printed = captureOutput();
    config.services = { ...config.services, clamav: { mem_limit: GB } } as typeof config.services;
    try {
      const { run, calls } = docker(8 * GB, "");
      expect(services(["up", "--full"], run)).toBe(0);
      expect(calls).toContain("docker compose --profile full up -d --wait postgres valkey");
      expect(calls).toContain("docker compose --profile full up -d clamav");
      expect(printed()).toContain("Starting clamav in the background");
      expect(
        services(["up", "--full"], docker(8 * GB, "", { "up -d clamav": { status: 5 } }).run),
      ).toBe(5);
    } finally {
      const { clamav: _, ...rest } = config.services as Record<string, unknown>;
      config.services = rest as typeof config.services;
    }
  });
});
