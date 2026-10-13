/**
 * The start-up scripts of replicated Valkey (deploy/charts/data/files/valkey-*.sh), run
 * with stand-ins for valkey-cli, valkey-server and valkey-sentinel that print what they
 * were given: which node each one follows, and what its Sentinel is configured with.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FILES = join(import.meta.dir, "../deploy/charts/data/files");
const NODES = ["v-0.apps.svc", "v-1.apps.svc", "v-2.apps.svc"];

// Each runs a shell script and its stand-ins: slow on a busy machine, so they get time.
setDefaultTimeout(30_000);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A node's disk and a PATH whose valkey-cli answers `sentinels` (host → primary). */
function node(sentinels: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "valkey-"));
  dirs.push(dir);
  const tool = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  // valkey-cli -t 2 -h <host> -p 26379 --raw sentinel get-master-addr-by-name primary
  const answers = Object.entries(sentinels)
    .map(([host, primary]) => `  ${host}) printf '%s\\n6379\\n' ${primary} ;;`)
    .join("\n");
  tool("valkey-cli", `case "$4" in\n${answers}\n  *) exit 1 ;;\nesac`);
  tool("valkey-server", 'echo "$@"');
  tool("valkey-sentinel", 'cat "$1"');
  const start = (script: string, self: string, extra: Record<string, string> = {}) => {
    const result = Bun.spawnSync(["sh", join(FILES, script)], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        DATA: dir,
        NODES: NODES.join(" "),
        SELF: self,
        VALKEY_PASSWORD: "secret",
        MAXMEMORY: "300mb",
        QUORUM: "2",
        ...extra,
      },
    });
    expect(result.stderr.toString()).toBe("");
    return result.stdout.toString().trim();
  };
  return { dir, start };
}

describe("a replicated Valkey node", () => {
  it("starts the first node as the primary on the very first start", () => {
    const args = node().start("valkey-node.sh", "v-0.apps.svc");
    expect(args).toBe(
      "--requirepass secret --masterauth secret --appendonly yes --maxmemory 300mb --maxmemory-policy noeviction --dir " +
        `${dirs[0]} --replica-announce-ip v-0.apps.svc`,
    );
  });

  it("follows the first node on the very first start otherwise", () => {
    expect(node().start("valkey-node.sh", "v-1.apps.svc")).toEndWith(
      "--replica-announce-ip v-1.apps.svc --replicaof v-0.apps.svc 6379",
    );
  });

  it("follows the primary the Sentinels name, after a failover", () => {
    // The first Sentinel is down (it was on the lost node); the second answers.
    const { start } = node({ "v-1.apps.svc": "v-2.apps.svc" });
    expect(start("valkey-node.sh", "v-0.apps.svc")).toEndWith("--replicaof v-2.apps.svc 6379");
    expect(start("valkey-node.sh", "v-2.apps.svc")).not.toContain("--replicaof");
  });

  it("follows the primary its own Sentinel last knew of when none answers", () => {
    const { dir, start } = node();
    writeFileSync(
      join(dir, "sentinel.conf"),
      "port 26379\nsentinel monitor primary v-1.apps.svc 6379 2\n",
    );
    expect(start("valkey-node.sh", "v-0.apps.svc")).toEndWith("--replicaof v-1.apps.svc 6379");
  });
});

describe("its Sentinel", () => {
  it("watches the first node on the very first start, with a majority's quorum", () => {
    const conf = node().start("valkey-sentinel.sh", "v-1.apps.svc");
    expect(conf.split("\n")).toEqual([
      "port 26379",
      "sentinel resolve-hostnames yes",
      "sentinel announce-hostnames yes",
      "sentinel monitor primary v-0.apps.svc 6379 2",
      "sentinel down-after-milliseconds primary 5000",
      "sentinel failover-timeout primary 60000",
      "sentinel parallel-syncs primary 1",
      "sentinel announce-ip v-1.apps.svc",
      "sentinel auth-pass primary secret",
    ]);
  });

  it("keeps what it learned across restarts, with the current name and password", () => {
    const { dir, start } = node();
    start("valkey-sentinel.sh", "v-1.apps.svc");
    // What Sentinel itself rewrote after a failover.
    const conf = join(dir, "sentinel.conf");
    writeFileSync(
      conf,
      readFileSync(conf, "utf8").replace("primary v-0.apps.svc", "primary v-2.apps.svc"),
    );
    const again = start("valkey-sentinel.sh", "v-1.apps.svc", { VALKEY_PASSWORD: "rotated" }).split(
      "\n",
    );
    expect(again).toContain("sentinel monitor primary v-2.apps.svc 6379 2");
    expect(again.filter((line) => line.startsWith("sentinel auth-pass"))).toEqual([
      "sentinel auth-pass primary rotated",
    ]);
    expect(again.filter((line) => line.startsWith("sentinel announce-ip"))).toHaveLength(1);
  });
});
