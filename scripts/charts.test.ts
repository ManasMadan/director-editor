import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { charts, kubernetesVersion } from "./charts";
import type { Ran } from "./lib";
import { captureOutput, fakeRun } from "./stand-ins";

const roots: string[] = [];
afterEach(() => {
  mock.restore();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const REPO = join(import.meta.dir, "..");
const VARIABLES = "infra/tofu/modules/bootstrap/variables.tf";

/** A copy of what the check reads: the deploy tree, .sops.yaml and the bootstrap's variables. */
function checkout() {
  const root = mkdtempSync(join(tmpdir(), "charts-"));
  roots.push(root);
  for (const path of ["deploy", ".sops.yaml", VARIABLES, "infra/tofu/modules/k3s/variables.tf"]) {
    cpSync(join(REPO, path), join(root, path), { recursive: true });
  }
  return root;
}

const RULES = `apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: alerts
spec:
  groups:
    - name: stack
      rules:
        - alert: ApiDown
          expr: up{job="api"} == 0
`;
const ARGOCD = [
  "name: argocd-cmp-cm",
  "sops.yaml: |",
  "path: /var/run/argocd/argocd-cmp-server",
  "secretName: sops-age",
].join("\n");

/** helm as if every chart rendered (each render names itself), and the tools installed. */
function tools(overrides: (line: string) => Partial<Ran> | undefined = () => undefined) {
  return fakeRun((line) => {
    const given = overrides(line);
    if (given) {
      return given;
    }
    if (line.includes("-s templates/rules.yaml")) {
      return { stdout: RULES };
    }
    if (line.startsWith("helm template argocd argo-cd")) {
      return { stdout: ARGOCD };
    }
    if (line.startsWith("helm template")) {
      return { stdout: `rendered: ${line.split(" ").slice(2, 4).join(" ")}\n` };
    }
    return undefined;
  });
}

/** A failure in each kind of step: a lint, an environment, the platform, the rules, Argo CD. */
function brokenIn(root: string) {
  return (line: string): Partial<Ran> | undefined => {
    if (line.startsWith("helm lint --strict") && line.includes("deploy/charts/data")) {
      return { status: 1, stderr: "values don't meet the schema" };
    }
    if (line.startsWith(`helm template production ${root}/deploy/charts/data`)) {
      return { status: 1, stderr: "production data broke" };
    }
    if (line.startsWith("helm template mail ")) {
      return { status: 1, stderr: "mail broke" };
    }
    if (line.startsWith("helm template optional ")) {
      return { status: 1, stderr: "optional broke" };
    }
    if (line.includes("-s templates/rules.yaml")) {
      return { status: 1, stderr: "rules broke" };
    }
    if (line.startsWith("helm template argocd argo-cd")) {
      return { stdout: "name: argocd-cm\n" };
    }
    return undefined;
  };
}

describe("the charts check", () => {
  it("lints, tests, renders and validates every chart, and checks the secrets", () => {
    const printed = captureOutput();
    const root = checkout();
    const { run, calls, options } = tools();
    expect(charts({ run, root })).toBe(0);

    for (const chart of ["deploy/charts/stack", "deploy/charts/data", "deploy/platform/alerts"]) {
      expect(calls.some((line) => line.startsWith(`helm lint --strict ${root}/${chart} `))).toBe(
        true,
      );
      expect(calls).toContain(`helm unittest ${root}/${chart}`);
    }
    expect(calls).toContain(
      `helm template preview ${root}/deploy/charts/stack --namespace preview -f ${root}/deploy/environments/preview/stack.yaml --set-string image.tag=sha-0000000 --set site.host=pr-1.preview.example.com --set observability.enabled=true`,
    );
    expect(calls).toContain(
      `helm template preview ${root}/deploy/charts/data --namespace preview -f ${root}/deploy/environments/preview/data.yaml --set preview.namespace=pr-1`,
    );
    // An optional feature no environment turns on, rendered on with the chart's values.
    expect(calls).toContain(
      `helm template optional ${root}/deploy/charts/data --namespace optional --set storage.uploads.host=files.a.b --set storage.uploads.corsOrigins[0]=https://a.b --set valkey.replication.enabled=true`,
    );
    expect(printed()).toContain("Valkey replication is valid Kubernetes");
    // Both of an environment's charts, validated together.
    const inputs = options.map((given) => given.input);
    expect(inputs).toContain(
      `rendered: staging ${root}/deploy/charts/data\n\n---\nrendered: staging ${root}/deploy/charts/stack\n`,
    );
    // The platform's own charts, as their add-on's release, in its namespace.
    expect(calls).toContain(
      `helm template platform-config ${root}/deploy/platform/config --namespace gateway-system --set domain=example.com --set tls.email=ops@example.com --set previews=true --set imagePolicy.enabled=true`,
    );
    // Add-ons from a Helm repository and from an OCI registry, at their pinned versions.
    const addon = (name: string) => calls.find((line) => line.startsWith(`helm template ${name} `));
    expect(addon("keda")).toMatch(
      /^helm template keda keda --repo https:\/\/kedacore\.github\.io\/charts --version \S+ --namespace keda -f \S+\/deploy\/platform\/values\/keda\.yaml$/,
    );
    expect(addon("envoy-gateway")).toMatch(
      /^helm template envoy-gateway oci:\/\/registry-1\.docker\.io\/envoyproxy\/gateway-helm --version \S+ --namespace envoy-gateway-system /,
    );
    // Rendered once, as our own chart, never as a chart to fetch.
    expect(calls.filter((line) => line.startsWith("helm template platform-config"))).toHaveLength(
      1,
    );
    const argocd = /default\s*=\s*"([^"]+)"/.exec(
      readFileSync(join(REPO, VARIABLES), "utf8").split('variable "argocd_version"')[1] ?? "",
    )?.[1];
    expect(calls).toContain(
      `helm template argocd argo-cd --repo https://argoproj.github.io/argo-helm --version ${argocd} --namespace argocd -f ${root}/deploy/argocd/argo-cd-values.yaml`,
    );
    // The alert rules go to promtool as Prometheus reads them.
    const promtool = calls.findIndex((line) => line.includes("promtool check rules"));
    expect(calls[promtool]).toStartWith("docker run --rm -i --memory=256m --entrypoint sh ");
    expect(JSON.parse(String(inputs[promtool]))).toEqual({
      groups: [{ name: "stack", rules: [{ alert: "ApiDown", expr: 'up{job="api"} == 0' }] }],
    });
    // The Argo CD manifests, validated as one stream.
    expect(inputs.at(-1)).toContain(readFileSync(join(root, "deploy/argocd/root.yaml"), "utf8"));
    expect(calls.at(-1)).toStartWith(
      `kubeconform -strict -summary -cache ${root}/node_modules/.cache/kubeconform -kubernetes-version ${kubernetesVersion()}`,
    );
    expect(options.every((given) => given.cwd === root)).toBe(true);
    expect(printed()).toContain("every committed secret is SOPS-encrypted (5 directories)");
    expect(printed()).not.toContain("✖");
  });

  it("validates in Docker when kubeconform isn't installed", () => {
    captureOutput();
    const root = checkout();
    const { run, calls } = tools((line) =>
      line === "kubeconform -v" ? { status: 127 } : undefined,
    );
    expect(charts({ run, root })).toBe(0);
    const user = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
    expect(calls.at(-1)).toStartWith(
      `docker run --rm -i --memory=256m --user ${user} -v ${root}/node_modules/.cache/kubeconform:/cache ghcr.io/yannh/kubeconform:v0.7.0 -strict -summary -cache /cache `,
    );
  });

  it("fails on each problem, with what the tool said", () => {
    const printed = captureOutput();
    const root = checkout();
    mkdirSync(join(root, "deploy/environments/qa"));
    writeFileSync(join(root, "deploy/environments/staging/secrets/api.yaml"), "kind: Secret\n");
    mkdirSync(join(root, "deploy/platform/secrets/staging/nested"));
    const { run, calls } = tools(brokenIn(root));
    expect(charts({ run, root })).toBe(1);
    const output = printed();
    expect(output).toContain("deploy/charts/data: lint");
    expect(output).toContain("values don't meet the schema");
    expect(output).toContain("qa: add it to RELEASE_VALUES in scripts/charts.ts");
    expect(output).toContain("production data broke");
    expect(calls.filter((line) => line.startsWith("helm template qa"))).toEqual([]);
    expect(output).toContain("mail broke");
    expect(output).toContain("optional broke");
    expect(output).toContain("rules broke");
    expect(calls.some((line) => line.includes("promtool"))).toBe(false);
    expect(output).toContain("the sops plugin or its sidecar is missing from the output");
    expect(output).toContain(
      "deploy/environments/staging/secrets/api.yaml: only *.sops.yaml files belong here",
    );
    expect(output).toContain("deploy/platform/secrets/staging/nested: not a file");
    // Only the environments whose charts both rendered are validated: not production.
    const validated = calls.filter((line) => line.startsWith("kubeconform -strict")).length;
    expect(validated).toBe(3 + 3 + 1);
  });

  it("fails when Argo CD's chart doesn't render, with helm's error", () => {
    const printed = captureOutput();
    const root = checkout();
    const { run } = tools((line) =>
      line.startsWith("helm template argocd argo-cd")
        ? { status: 1, stderr: "chart not found" }
        : undefined,
    );
    expect(charts({ run, root })).toBe(1);
    expect(printed()).toContain("chart not found");
  });

  it("fails without Argo CD's version, and without platform Secrets checks nothing there", () => {
    const printed = captureOutput();
    const root = checkout();
    writeFileSync(join(root, VARIABLES), 'variable "cluster_name" {}\n');
    rmSync(join(root, "deploy/platform/secrets"), { recursive: true });
    const { run, calls } = tools();
    expect(charts({ run, root })).toBe(1);
    expect(printed()).toContain(
      "argocd_version not found in infra/tofu/modules/bootstrap/variables.tf",
    );
    expect(calls.some((line) => line.startsWith("helm template argocd"))).toBe(false);
    expect(printed()).toContain("every committed secret is SOPS-encrypted (3 directories)");
  });
});

describe("the Kubernetes version", () => {
  it("is the clusters' own, from their k3s release", () => {
    const k3s = readFileSync(join(REPO, "infra/tofu/modules/k3s/variables.tf"), "utf8");
    expect(k3s).toContain(`default = "v${kubernetesVersion()}+k3s`);
  });

  it("is the dev container's kubectl, to the minor version", () => {
    const devcontainer = readFileSync(join(REPO, ".devcontainer/devcontainer.json"), "utf8");
    const kubectl = /depName=kubernetes\/kubernetes\s*"version":\s*"(\d+\.\d+)\./.exec(
      devcontainer,
    )?.[1];
    expect(kubectl).toBe(kubernetesVersion().split(".").slice(0, 2).join("."));
  });

  it("is kind's node image, to the minor version", () => {
    const kind = readFileSync(join(REPO, "deploy/local/kind.yaml"), "utf8");
    const node = /image: kindest\/node:v(\d+\.\d+)\.\d+@sha256:[0-9a-f]{64}\n/.exec(kind)?.[1];
    expect(node).toBe(kubernetesVersion().split(".").slice(0, 2).join("."));
  });

  it("can't be read without a k3s release", () => {
    const root = mkdtempSync(join(tmpdir(), "charts-"));
    roots.push(root);
    mkdirSync(join(root, "infra/tofu/modules/k3s"), { recursive: true });
    writeFileSync(join(root, "infra/tofu/modules/k3s/variables.tf"), 'variable "nodes" {}\n');
    expect(() => kubernetesVersion(root)).toThrow("No k3s_version default");
  });
});

describe("every chart of ours", () => {
  // Unknown or misspelled values fail `helm template` instead of doing nothing.
  it("has a values schema that refuses keys it doesn't know", () => {
    const charts = readdirSync(join(REPO, "deploy"), { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith("Chart.yaml") && !path.startsWith(".rendered"))
      .map((path) => dirname(join("deploy", path)));
    expect(charts.length).toBeGreaterThan(5);
    const loose = charts.filter((chart) => {
      const schema = join(REPO, chart, "values.schema.json");
      return (
        !existsSync(schema) ||
        (JSON.parse(readFileSync(schema, "utf8")) as { additionalProperties?: unknown })
          .additionalProperties !== false
      );
    });
    expect(loose).toEqual([]);
  });
});

describe("the values files", () => {
  // Helm keeps the last of two keys of the same name without a word, so a block added for
  // one setting can silently replace a whole section written above it.
  it("never repeat a top-level key", () => {
    const files = [
      ...readdirSync(join(REPO, "deploy"), { recursive: true, encoding: "utf8" })
        .filter((path) => /(^|\/)values[^/]*\.yaml$|argo-cd-values\.yaml$/.test(path))
        .filter((path) => !path.startsWith(".rendered") && !path.includes("/tests/"))
        .map((path) => join("deploy", path)),
      ...readdirSync(join(REPO, "deploy/platform/values")).map(
        (f) => `deploy/platform/values/${f}`,
      ),
      ...readdirSync(join(REPO, "deploy/environments"), { recursive: true, encoding: "utf8" })
        .filter((path) => path.endsWith(".yaml") && !path.includes("secrets"))
        .map((path) => `deploy/environments/${path}`),
    ];
    expect(files.length).toBeGreaterThan(10);
    const repeated = [...new Set(files)].flatMap((file) => {
      const keys: string[] =
        readFileSync(join(REPO, file), "utf8").match(/^[A-Za-z][\w.-]*(?=:)/gm) ?? [];
      return keys.filter((key, i) => keys.indexOf(key) !== i).map((key) => `${file}: ${key}`);
    });
    expect(repeated).toEqual([]);
  });
});
