import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applicationRenders, environments, platformRenders } from "./charts";
import { type Ran, ROOT } from "./lib";
import { misconfig, misconfigReads, RENDERED, renderCharts, TRIVY_VERSION } from "./misconfig";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

/** A checkout with these environments and one platform chart, as the renders read it. */
function checkout(...environments: string[]) {
  const root = mkdtempSync(join(tmpdir(), "misconfig-"));
  mkdirSync(join(root, "deploy/environments"), { recursive: true });
  mkdirSync(join(root, "deploy/platform/addons/observability"), { recursive: true });
  writeFileSync(
    join(root, "deploy/platform/addons/mail.yaml"),
    "addon: mail\nnamespace: mail\npath: deploy/platform/mail\n",
  );
  // An add-on defined without where to get it renders nothing.
  writeFileSync(
    join(root, "deploy/platform/addons/observability/keda.yaml"),
    "addon: keda\nnamespace: keda\nchart: keda\n",
  );
  // No Argo CD version: no Argo CD chart.
  mkdirSync(join(root, "infra/tofu/modules/bootstrap"), { recursive: true });
  writeFileSync(join(root, "infra/tofu/modules/bootstrap/variables.tf"), 'variable "x" {}\n');
  for (const env of environments) {
    mkdirSync(join(root, "deploy/environments", env), { recursive: true });
  }
  return root;
}

/** helm renders each chart as `rendered <name>`, and trivy answers with `trivy`. */
function tools(trivy: (line: string) => Partial<Ran> | undefined) {
  return fakeRun((line) => {
    const name = /^helm template (\S+) \S+\/(\w+) /.exec(line);
    return name ? { stdout: `rendered ${name[1]}-${name[2]}\n` } : trivy(line);
  });
}

describe("the misconfiguration scan", () => {
  it("renders every chart of ours, then scans with a local trivy of CI's version", () => {
    const root = checkout("production");
    const { run, calls, options } = tools((line) => {
      if (line === "trivy --version") {
        return { stdout: `Version: ${TRIVY_VERSION}\n` };
      }
      return line.startsWith("trivy config") ? { status: 1 } : undefined;
    });
    expect(misconfig(["--format", "sarif"], run, root, "/cache")).toBe(1);
    expect(calls.filter((line) => line.startsWith("helm template"))).toHaveLength(
      applicationRenders(root).length + 1,
    );
    expect(calls).toContain(
      `helm template mail ${join(root, "deploy/platform/mail")} --namespace mail --set domain=example.com`,
    );
    expect(calls.slice(-2)).toEqual([
      "trivy --version",
      "trivy config --quiet --format sarif . --cache-dir /cache",
    ]);
    expect(options.at(-1)).toMatchObject({ cwd: root, stdio: "inherit" });
    expect(options.at(-1)?.env?.TF_VAR_state_passphrase).toBe("scanned-not-applied");
    expect(readFileSync(join(root, RENDERED, "production-data.yaml"), "utf8")).toBe(
      "rendered production-data\n",
    );
  });

  it("starts from an empty folder of renders, so a removed one doesn't linger", () => {
    const root = checkout("production");
    mkdirSync(join(root, RENDERED), { recursive: true });
    writeFileSync(join(root, RENDERED, "gone.yaml"), "old");
    expect(renderCharts(tools(() => undefined).run, root)).toBe(true);
    expect(readdirSync(join(root, RENDERED))).not.toContain("gone.yaml");
  });

  it("scans each isolated kind in a pass of its own, failing on any pass", () => {
    const root = checkout("preview");
    const manifests = [
      "kind: Deployment\nmetadata: { name: app }\n",
      "\nkind: LimitRange\nmetadata: { name: preview }\n",
      "\nkind: ResourceQuota\nmetadata: { name: preview }\n",
    ].join("---");
    const { run, calls } = fakeRun((line) => {
      if (line.startsWith("helm template preview")) {
        return { stdout: manifests };
      }
      if (line === "trivy --version") {
        return { stdout: `Version: ${TRIVY_VERSION}\n` };
      }
      return line.includes("isolated/ResourceQuota") ? { status: 1 } : {};
    });
    expect(misconfig(["--format", "sarif"], run, root, "/cache")).toBe(1);
    const rendered = (path: string) => readFileSync(join(root, RENDERED, path), "utf8");
    expect(rendered("preview-data.yaml")).toBe("kind: Deployment\nmetadata: { name: app }\n");
    expect(rendered("isolated/LimitRange/preview-data.yaml")).toContain("kind: LimitRange");
    expect(rendered("isolated/ResourceQuota/preview-data.yaml")).toContain("kind: ResourceQuota");
    expect(calls.filter((line) => line.startsWith("trivy config"))).toEqual([
      "trivy config --quiet --format sarif . --cache-dir /cache",
      `trivy config --quiet ${RENDERED}/isolated/LimitRange --cache-dir /cache`,
      `trivy config --quiet ${RENDERED}/isolated/ResourceQuota --cache-dir /cache`,
    ]);
  });

  it("renders the add-ons' and Argo CD's charts from copies pulled once, without their tests", () => {
    const root = checkout();
    writeFileSync(
      join(root, "deploy/platform/addons/cert-manager.yaml"),
      "addon: cert-manager\nnamespace: cert-manager\nrepoURL: https://charts.jetstack.io\nchart: cert-manager\nversion: v1.2.3\n",
    );
    writeFileSync(
      join(root, "infra/tofu/modules/bootstrap/variables.tf"),
      'variable "argocd_version" {\n  default = "10.9.2"\n}\n',
    );
    const charts = mkdtempSync(join(tmpdir(), "charts-"));
    const { run, calls } = fakeRun((line) => {
      const destination = /^helm pull (\S+).* --destination (\S+)$/.exec(line);
      if (destination) {
        writeFileSync(join(destination[2] ?? "", `${destination[1]}.tgz`), "chart");
      }
      return line.startsWith("helm template") ? { stdout: "kind: Deployment\n" } : {};
    });
    expect(renderCharts(run, root, charts)).toBe(true);
    expect(calls.find((line) => line.startsWith("helm pull cert-manager"))).toStartWith(
      `helm pull cert-manager --repo https://charts.jetstack.io --version v1.2.3 --destination ${charts}/pull-`,
    );
    expect(calls).toContain(
      `helm template cert-manager ${charts}/cert-manager-v1.2.3.tgz --version v1.2.3 --namespace cert-manager -f ${root}/deploy/platform/values/cert-manager.yaml --skip-tests`,
    );
    expect(calls).toContain(
      `helm template argocd ${charts}/argocd-10.9.2.tgz --version 10.9.2 --namespace argocd -f ${root}/deploy/argocd/argo-cd-values.yaml --skip-tests`,
    );
    expect(readdirSync(charts).sort()).toEqual(["argocd-10.9.2.tgz", "cert-manager-v1.2.3.tgz"]);
    expect(readdirSync(join(root, RENDERED))).toContain("addon-cert-manager.yaml");
    // Cached: the next scan pulls nothing.
    const again = fakeRun(() => ({ stdout: "kind: Deployment\n" }));
    expect(renderCharts(again.run, root, charts)).toBe(true);
    expect(again.calls.some((line) => line.startsWith("helm pull"))).toBe(false);
  });

  it("stops when a chart can't be pulled", () => {
    const printed = captureOutput();
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    const root = checkout();
    writeFileSync(
      join(root, "infra/tofu/modules/bootstrap/variables.tf"),
      'variable "argocd_version" {\n  default = "10.9.2"\n}\n',
    );
    const charts = mkdtempSync(join(tmpdir(), "charts-"));
    const { run } = fakeRun((line) =>
      line.startsWith("helm pull") ? { status: 1, stderr: "no such chart" } : {},
    );
    expect(renderCharts(run, root, charts)).toBe(false);
    expect(stderr).toHaveBeenCalledWith("no such chart");
    expect(printed()).toContain("helm couldn't pull the chart for addon-argocd");
    expect(readdirSync(charts)).toEqual([]);
  });

  it("runs its image when the local trivy is another version, or missing", () => {
    const root = checkout();
    for (const local of [{ stdout: "Version: 0.1.0\n" }, { status: null }]) {
      const { run, calls } = fakeRun((line) => (line === "trivy --version" ? local : {}));
      expect(misconfig([], run, root)).toBe(0);
      expect(calls.at(-1)).toBe(
        `docker run --rm --memory=512m -v ${root}:${root} -w ${root} -e TF_VAR_state_passphrase=scanned-not-applied aquasec/trivy:${TRIVY_VERSION} config --quiet .`,
      );
    }
  });

  it("fails rather than skipping when there's neither, and when trivy can't start", () => {
    const printed = captureOutput();
    const root = checkout();
    expect(misconfig([], tools(() => ({ status: 1 })).run, root)).toBe(1);
    expect(printed()).toContain("isn't installed and Docker isn't running");
    const { run } = fakeRun((line) => (line.startsWith("docker run") ? { status: null } : {}));
    expect(misconfig([], run, root)).toBe(1);
  });

  it("fails without helm, or when a chart doesn't render, scanning nothing", () => {
    const printed = captureOutput();
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    const root = checkout("production");
    const missing = fakeRun((line) => (line.startsWith("helm") ? { status: null } : {}));
    expect(misconfig([], missing.run, root)).toBe(1);
    expect(printed()).toContain("helm isn't installed");
    const broken = fakeRun((line) =>
      line.startsWith("helm") ? { status: 1, stderr: "image.tag is required" } : {},
    );
    expect(misconfig([], broken.run, root)).toBe(1);
    expect(stderr).toHaveBeenCalledWith("image.tag is required");
    expect(printed()).toContain("helm couldn't render production-data");
    expect(broken.calls.some((line) => line.startsWith("trivy"))).toBe(false);
  });

  it("refuses an environment it doesn't know how to render", () => {
    expect(() => applicationRenders(checkout("qa"))).toThrow(
      "qa: add it to RELEASE_VALUES in scripts/charts.ts",
    );
  });

  // A chart added anywhere under deploy/ must be rendered for the scan too: Trivy alone
  // skips any chart that needs values to render.
  it("renders every chart under deploy/, the application's for every environment", () => {
    const charts = readdirSync(join(ROOT, "deploy"), { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith("Chart.yaml") && !path.startsWith(".rendered"))
      .map((path) => join(ROOT, "deploy", dirname(path)));
    const renders = [...applicationRenders(ROOT), ...platformRenders(ROOT)];
    expect(charts.length).toBeGreaterThan(2);
    for (const chart of charts) {
      expect(renders.map((render) => render.args[2])).toContain(chart);
    }
    for (const chart of readdirSync(join(ROOT, "deploy/charts"))) {
      for (const env of environments(ROOT)) {
        expect(renders.map((render) => render.name)).toContain(`${env}-${chart}`);
      }
    }
  });

  it.each([
    ["deploy/docker/web.Dockerfile", true],
    [".devcontainer/Dockerfile", true],
    ["deploy/platform/jaeger/values.yaml", true],
    ["infra/tofu/envs/k3s/main.tf", true],
    ["trivy.yaml", true],
    ["scripts/charts.ts", true],
    [".trivyignore.yaml", true],
    ["apps/api/src/main.ts", false],
    ["docs/deploy.md", false],
  ])("reads %s: %p", (path, reads) => {
    expect(misconfigReads(path)).toBe(reads);
  });

  it("is CI's scan: this script, at the same Trivy, with trivy.yaml deciding the rest", () => {
    const security = readFileSync(join(ROOT, ".github/workflows/security.yml"), "utf8");
    const job = security.slice(
      security.indexOf("  misconfig:"),
      security.indexOf("  security-ok:"),
    );
    expect(job).toContain(`version: v${TRIVY_VERSION}\n`);
    expect(job).toContain(
      "run: bun scripts/misconfig.ts --format sarif --output trivy-config.sarif\n",
    );
    for (const input of [
      "exit-code:",
      "skip-dirs:",
      "severity:",
      "trivyignores:",
      "trivy-action",
    ]) {
      expect(job).not.toContain(input);
    }
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain(`TRIVY: aquasec/trivy:${TRIVY_VERSION}\n`);
    expect(readFileSync(join(ROOT, ".gitignore"), "utf8")).toContain(`\n${RENDERED}/\n`);
  });

  // Trivy doesn't read .gitignore, and the pre-push hook runs it beside the suites that
  // write and delete their output: a folder it walks into mid-change fails the scan.
  it("skips every folder .gitignore lists", () => {
    const skipped = /skip-dirs:\n((?:\s+- .+\n)+)/
      .exec(readFileSync(join(ROOT, "trivy.yaml"), "utf8"))?.[1]
      ?.match(/- "?([^"\n]+)"?/g)
      ?.map((line) => line.replace(/^- "?|"?$/g, ""));
    const FILES = [".env", ".DS_Store", ".coverage", "next-env.d.ts", "CLAUDE.local.md"];
    const folders = readFileSync(join(ROOT, ".gitignore"), "utf8")
      .split("\n")
      .map((line) => line.replace(/^\*\*\//, "").replace(/\/$/, ""))
      .filter((line) => /^[\w.-]+$/.test(line) && !FILES.includes(line));
    expect(folders.filter((name) => !skipped?.includes(`**/${name}`))).toEqual([]);
  });
});
