/**
 * The data chart's backup drill (deploy/charts/data/files/restore-drill.sh), run against
 * a stand-in kubectl that records what it's asked and answers for two clusters: the
 * live one and the scratch one the latest backup is restored into.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../deploy/charts/data/files/restore-drill.sh");

// Each runs a shell script and its stand-ins: slow on a busy machine, so they get time.
setDefaultTimeout(30_000);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const LIVE = [
  "table public.todo rows=12 hash=-3409 rls=true forced=true",
  "policy public.todo tenant PERMISSIVE ALL roles={app_api} using=(org) check=(org)",
  "grant app_api SELECT on public.todo",
  "sequence public.todo_id_seq last=12",
];

/** Runs the drill; `restored` is what the scratch cluster's fingerprint prints. */
function drill({
  restored = [
    "table public.todo rows=9 hash=771 rls=true forced=true",
    "policy public.todo tenant PERMISSIVE ALL roles={app_api} using=(org) check=(org)",
    "grant app_api SELECT on public.todo",
    "sequence public.todo_id_seq last=9",
  ],
  age = "3600",
  ready = 0,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "drill-"));
  dirs.push(dir);
  writeFileSync(join(dir, "live-1.facts"), `${LIVE.join("\n")}\n`);
  writeFileSync(join(dir, "live-drill-1.facts"), `${restored.join("\n")}\n`);
  writeFileSync(join(dir, "fingerprint.sql"), "select 'facts'");
  writeFileSync(
    join(dir, "kubectl"),
    `#!/bin/sh
echo "kubectl $*" >> "${dir}/calls"
case "$1" in
  wait) exit ${ready} ;;
  get) printf '%s' "$(echo "$4" | sed -E 's/^cnpg.io\\/cluster=([^,]+),.*/\\1/')-1" ;;
  exec)
    case "$*" in
      *pg_last_xact_replay_timestamp*) echo "${age}" ;;
      *) cat "${dir}/$2.facts" ;;
    esac ;;
esac
`,
  );
  chmodSync(join(dir, "kubectl"), 0o755);
  const result = Bun.spawnSync(["sh", SCRIPT], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      TMPDIR: dir,
      CLUSTER: "live",
      DRILL: "live-drill",
      DATABASE: "app",
      MAX_AGE_HOURS: "26",
      TIMEOUT: "60m",
      SPEC: "/drill/cluster.yaml",
      FINGERPRINT: join(dir, "fingerprint.sql"),
    },
  });
  const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  return {
    status: result.exitCode,
    out: result.stdout.toString() + result.stderr.toString(),
    calls,
  };
}

describe("the backup drill", () => {
  it("restores into a fresh scratch cluster and passes when the structure matches", () => {
    const { status, out, calls } = drill();
    expect(status).toBe(0);
    expect(calls.slice(0, 3)).toEqual([
      "kubectl delete cluster live-drill --ignore-not-found --wait=true",
      "kubectl apply -f /drill/cluster.yaml",
      "kubectl wait cluster/live-drill --for=condition=Ready --timeout=60m",
    ]);
    // psql in each cluster's primary, against the database.
    expect(calls).toContain(
      "kubectl get pod -l cnpg.io/cluster=live,cnpg.io/instanceRole=primary -o jsonpath={.items[0].metadata.name}",
    );
    expect(
      calls.some(
        (c) =>
          c.startsWith("kubectl exec live-drill-1 -c postgres -- psql") && c.includes("-d app"),
      ),
    ).toBe(true);
    // Rows and sequences moved on in the live database since the backup: not compared.
    expect(out).toContain(
      "Restored 1 tables, identical in structure; the last transaction is 60 minutes old.",
    );
    expect(calls.at(-1)).toBe("kubectl delete cluster live-drill --ignore-not-found --wait=false");
  });

  it("fails on a policy, grant or table the restore lost, and still removes the scratch cluster", () => {
    const { status, out, calls } = drill({
      restored: ["table public.todo rows=9 hash=771 rls=true forced=true"],
    });
    expect(status).toBe(1);
    expect(out).toContain("-grant app_api SELECT on public.todo");
    expect(out).toContain("The restored database differs from the live one");
    expect(calls.at(-1)).toBe("kubectl delete cluster live-drill --ignore-not-found --wait=false");
  });

  it("fails when the restored data is older than allowed: WAL isn't reaching the backups", () => {
    const { status, out } = drill({ age: String(30 * 3600) });
    expect(status).toBe(1);
    expect(out).toContain("The restored data is 30 hours old, more than 26");
  });

  it("fails when the restore replayed nothing", () => {
    const { status, out } = drill({ age: "-1" });
    expect(status).toBe(1);
    expect(out).toContain("The restore replayed no transactions");
  });

  it("fails when the scratch cluster never comes up, and removes it", () => {
    const { status, calls } = drill({ ready: 1 });
    expect(status).not.toBe(0);
    expect(calls.some((c) => c.startsWith("kubectl exec"))).toBe(false);
    expect(calls.at(-1)).toBe("kubectl delete cluster live-drill --ignore-not-found --wait=false");
  });
});

describe("where it runs", () => {
  type Data = {
    postgres?: { backups?: { enabled?: boolean }; drill?: { enabled?: boolean } };
    offsite?: { endpoint?: string };
  };
  const values = (env: string) =>
    Bun.YAML.parse(
      readFileSync(join(import.meta.dir, `../deploy/environments/${env}/data.yaml`), "utf8"),
    ) as Data;

  it("drills every environment with backups, production from its offsite copy", () => {
    for (const env of ["staging", "production"]) {
      const { postgres } = values(env);
      expect({ env, backups: postgres?.backups?.enabled, drill: postgres?.drill?.enabled }).toEqual(
        { env, backups: true, drill: true },
      );
    }
    // With an offsite endpoint the chart restores from that copy (its tests check how).
    expect(values("production").offsite?.endpoint).toStartWith("https://");
  });
});
