/**
 * Checks the Helm charts the way CI does: `bun run charts:check`.
 *
 *   1. helm lint, with values.schema.json (unknown or malformed values fail), and
 *      helm-unittest, for every chart of ours: deploy/charts/{stack,data} and the
 *      platform's (deploy/platform/{config,mail,jaeger,alerts});
 *   2. renders both application charts for every environment in deploy/environments,
 *      as Argo CD would, and validates each manifest against the Kubernetes API of the
 *      version the clusters run (k3s's, infra/tofu/modules/k3s) and the CRDs it uses (Gateway API, KEDA, CloudNativePG, Barman Cloud) with kubeconform;
 *      and the optional features no environment turns on (OPTIONAL), the same way;
 *   3. the platform: our charts rendered and validated the same way, every add-on chart
 *      at its pinned version with our values (their own schemas reject unknown keys),
 *      Argo CD's chart with deploy/argocd/argo-cd-values.yaml, and the Argo CD manifests;
 *   4. every file under deploy/environments/<env>/secrets/ and
 *      deploy/platform/secrets/<env>/ is a SOPS-encrypted Secret: nothing in plain text
 *      is ever committed there (scripts/secrets-check.ts, which the pre-commit hook runs
 *      on staged files too).
 *
 * Needs helm with the unittest plugin (`helm plugin install
 * https://github.com/helm-unittest/helm-unittest`) and either kubeconform or Docker.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import { fail, ok, ROOT, runMain, runSync } from "./lib";
import { recipientsFor, unsafeSecret } from "./secrets-check";

/** The Kubernetes version of the clusters' k3s release, which Renovate keeps current. */
export function kubernetesVersion(root = ROOT) {
  const variables = readFileSync(join(root, "infra/tofu/modules/k3s/variables.tf"), "utf8");
  const version = /variable "k3s_version"[\s\S]*?default\s*=\s*"v(\d+\.\d+\.\d+)\+k3s\d+"/.exec(
    variables,
  )?.[1];
  if (!version) {
    throw new Error("No k3s_version default in infra/tofu/modules/k3s/variables.tf");
  }
  return version;
}
const KUBECONFORM_IMAGE = "ghcr.io/yannh/kubeconform:v0.7.0";
const PROMETHEUS_IMAGE = "docker.io/prom/prometheus:v3.15.0";
// The CRD schema catalog at a commit, not its moving main branch: Renovate proposes a
// newer one (renovate.json5).
const CRD_SCHEMAS =
  "https://raw.githubusercontent.com/datreeio/CRDs-catalog/4c8dc296d32b06d15ccde9668ff136c951f4d539/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json";

/** What each environment's release needs besides its values file (set by Argo CD / CI). */
const RELEASE_VALUES: Record<string, { stack: string[]; data: string[] }> = {
  local: { stack: [], data: [] },
  preview: {
    stack: [
      "--set-string",
      "image.tag=sha-0000000",
      "--set",
      "site.host=pr-1.preview.example.com",
      "--set",
      "observability.enabled=true",
    ],
    data: ["--set", "preview.namespace=pr-1"],
  },
  staging: { stack: ["--set-string", "image.tag=sha-0000000"], data: [] },
  production: { stack: ["--set-string", "image.tag=sha-0000000"], data: [] },
};

/** Our charts, with the values a cluster or environment always sets. */
const OWN_CHARTS: Record<string, string[]> = {
  "deploy/charts/stack": ["--set", "image.tag=sha-0", "--set", "site.host=a.b"],
  "deploy/charts/data": [
    "--set",
    "storage.uploads.host=files.a.b",
    "--set",
    "storage.uploads.corsOrigins[0]=https://a.b",
  ],
  "deploy/platform/config": [
    "--set",
    "domain=example.com",
    "--set",
    "tls.email=ops@example.com",
    "--set",
    "previews=true",
    "--set",
    "imagePolicy.enabled=true",
  ],
  "deploy/platform/mail": ["--set", "domain=example.com"],
  "deploy/platform/jaeger": [],
  "deploy/platform/alerts": ["--set", "domain=example.com", "--set", "email=ops@example.com"],
};

/**
 * Features that are off in every environment, rendered on and validated all the same, so
 * turning one on isn't the first time its manifests meet the schemas. Chart → values.
 */
const OPTIONAL: [label: string, chart: string, values: string[]][] = [
  ["Valkey replication", "deploy/charts/data", ["--set", "valkey.replication.enabled=true"]],
];

/**
 * An add-on's definition (deploy/platform/addons): a chart from a repository, or one of
 * ours by its path.
 */
const addonFile = z
  .object({
    addon: z.string(),
    namespace: z.string(),
    repoURL: z.string(),
    chart: z.string(),
    version: z.string(),
    path: z.string(),
  })
  .partial();
const fields = (file: string) => addonFile.parse(Bun.YAML.parse(readFileSync(file, "utf8")));

type Result = { ok: boolean; output: string };

/** What every section of the check shares: the repo, a command runner, and the verdicts. */
type Checks = {
  root: string;
  exec: (command: string, args: string[], input?: string) => Result;
  kubeconform: (manifests: string) => Result;
  /** Reports a step's result; a failed one fails the run. */
  check: (label: string, result: Result) => void;
  /** Fails the run with a message. */
  refuse: (message: string) => void;
};

/** A kubeconform run on `manifests`: the local binary, or its image in Docker. */
function kubeconformWith(exec: Checks["exec"], root: string) {
  const hasKubeconform = exec("kubeconform", ["-v"]).ok;
  /**
   * Where kubeconform keeps the schemas it downloads: every environment and chart asks for
   * the same few dozen, and fetching each again for every one made a run take minutes on a
   * slow connection. CI caches the directory too (ci.yml's charts job).
   */
  const SCHEMA_CACHE = join(root, "node_modules/.cache/kubeconform");
  mkdirSync(SCHEMA_CACHE, { recursive: true });
  const args = (cache: string) => [
    "-strict",
    "-summary",
    "-cache",
    cache,
    "-kubernetes-version",
    kubernetesVersion(root),
    "-schema-location",
    "default",
    "-schema-location",
    CRD_SCHEMAS,
    "-",
  ];
  return (manifests: string) => {
    if (hasKubeconform) {
      return exec("kubeconform", args(SCHEMA_CACHE), manifests);
    }
    const user = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
    return exec(
      "docker",
      [
        "run",
        "--rm",
        "-i",
        "--memory=256m",
        "--user",
        user,
        "-v",
        `${SCHEMA_CACHE}:/cache`,
        KUBECONFORM_IMAGE,
        ...args("/cache"),
      ],
      manifests,
    );
  };
}

const prometheusRule = z.object({ spec: z.object({ groups: z.unknown() }) });

/** `promtool check rules` on a rendered PrometheusRule. */
function promtool(exec: Checks["exec"], manifest: string) {
  const { spec } = prometheusRule.parse(Bun.YAML.parse(manifest));
  const script = "cat > /tmp/rules.yaml && promtool check rules /tmp/rules.yaml";
  return exec(
    "docker",
    ["run", "--rm", "-i", "--memory=256m", "--entrypoint", "sh", PROMETHEUS_IMAGE, "-c", script],
    JSON.stringify({ groups: spec.groups }),
  );
}

/** helm lint and helm-unittest for each of our charts. */
function checkOwnCharts({ root, exec, check }: Checks) {
  for (const [chart, values] of Object.entries(OWN_CHARTS)) {
    const path = join(root, chart);
    check(`${chart}: lint`, exec("helm", ["lint", "--strict", path, ...values]));
    check(`${chart}: unit tests`, exec("helm", ["unittest", path]));
  }
}

/** The application charts, rendered for every environment and optional feature. */
export const APPLICATION_CHARTS = ["data", "stack"] as const;

/** A `helm template` run of one application chart: its name and its arguments. */
export type Render = { name: string; args: string[] };

/** One environment's release of `chart`, as Argo CD renders it, or none without its values. */
export function environmentRender(
  root: string,
  env: string,
  chart: (typeof APPLICATION_CHARTS)[number],
): Render | undefined {
  const extra = RELEASE_VALUES[env];
  if (!extra) {
    return undefined;
  }
  const values = join(root, "deploy/environments", env, `${chart}.yaml`);
  const args = ["template", env, join(root, "deploy/charts", chart), "--namespace", env];
  return { name: `${env}-${chart}`, args: [...args, "-f", values, ...extra[chart]] };
}

/** An optional feature's render: its chart with the values a cluster always sets, and it on. */
export function optionalRender(root: string, [label, chart, values]: (typeof OPTIONAL)[number]) {
  const slug = label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
  const args = ["template", "optional", join(root, chart), "--namespace", "optional"];
  return { name: `optional-${slug}`, args: [...args, ...(OWN_CHARTS[chart] ?? []), ...values] };
}

/** The environments, as deploy/environments has them. */
export const environments = (root: string) => readdirSync(join(root, "deploy/environments")).sort();

/**
 * Every render of the application charts: each environment's, then each optional
 * feature's. Throws for an environment missing from RELEASE_VALUES.
 */
export function applicationRenders(root = ROOT): Render[] {
  return [
    ...environments(root).flatMap((env) =>
      APPLICATION_CHARTS.map((chart) => {
        const render = environmentRender(root, env, chart);
        if (!render) {
          throw new Error(`${env}: add it to RELEASE_VALUES in scripts/charts.ts`);
        }
        return render;
      }),
    ),
    ...OPTIONAL.map((optional) => optionalRender(root, optional)),
  ];
}

/** Both application charts rendered for every environment, then validated together. */
function checkEnvironments({ root, exec, kubeconform, check, refuse }: Checks) {
  for (const env of environments(root)) {
    const rendered: string[] = [];
    for (const chart of APPLICATION_CHARTS) {
      const render = environmentRender(root, env, chart);
      if (!render) {
        refuse(`${env}: add it to RELEASE_VALUES in scripts/charts.ts`);
        break;
      }
      const result = exec("helm", render.args);
      check(`${env}: ${chart} renders`, result);
      if (result.ok) {
        rendered.push(result.output);
      }
    }
    if (rendered.length === APPLICATION_CHARTS.length) {
      check(`${env}: manifests are valid Kubernetes`, kubeconform(rendered.join("\n---\n")));
    }
  }
}

/** The optional features no environment turns on, rendered and validated the same way. */
function checkOptional({ root, exec, kubeconform, check }: Checks) {
  for (const optional of OPTIONAL) {
    const result = exec("helm", optionalRender(root, optional).args);
    check(`${optional[0]} renders`, result);
    if (result.ok) {
      check(`${optional[0]} is valid Kubernetes`, kubeconform(result.output));
    }
  }
}

/** The add-on definitions (deploy/platform/addons and its observability folder). */
function addons(root: string) {
  const platform = join(root, "deploy/platform");
  return [join(platform, "addons"), join(platform, "addons/observability")].flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith(".yaml"))
      .sort()
      .map((file) => fields(join(dir, file))),
  );
}

/**
 * The platform's own charts (the add-ons with a `path` in this repository), rendered as
 * Argo CD does: the add-on's release name and namespace, and the values a cluster sets.
 */
export function platformRenders(root = ROOT): Render[] {
  return addons(root).flatMap(({ addon, namespace, path }) =>
    addon && namespace && path
      ? [
          {
            name: `platform-${addon}`,
            args: [
              "template",
              addon,
              join(root, path),
              "--namespace",
              namespace,
              ...(OWN_CHARTS[path] ?? []),
            ],
          },
        ]
      : [],
  );
}

/** The platform's own charts rendered and validated, and the alert rules through promtool. */
function checkPlatform({ root, exec, kubeconform, check }: Checks) {
  const platform = join(root, "deploy/platform");
  for (const { name, args } of platformRenders(root)) {
    const result = exec("helm", args);
    check(`${name} renders`, result);
    if (result.ok) {
      check(`${name} is valid Kubernetes`, kubeconform(result.output));
    }
  }

  // The alert rules, as Prometheus itself reads them (promtool, in Docker).
  const rules = exec("helm", [
    "template",
    "alerts",
    join(platform, "alerts"),
    "-s",
    "templates/rules.yaml",
    ...(OWN_CHARTS["deploy/platform/alerts"] ?? []),
  ]);
  check("alert rules pass promtool", rules.ok ? promtool(exec, rules.output) : rules);
}

/** A chart of someone else's, at its pinned version, as a cluster installs it. */
export type RemoteChart = {
  name: string;
  namespace: string;
  /** Where helm gets it: a chart and its repository, or an OCI reference. */
  source: string[];
  version: string;
  values: string;
};

/** The add-on charts from Helm repositories and OCI registries (deploy/platform/addons). */
export function addonCharts(root = ROOT): RemoteChart[] {
  return addons(root).flatMap(({ addon, chart, namespace, repoURL, version }) =>
    addon && chart && namespace && repoURL && version
      ? [
          {
            name: addon,
            namespace,
            version,
            values: join(root, "deploy/platform/values", `${addon}.yaml`),
            source: repoURL.startsWith("https://")
              ? [chart, "--repo", repoURL]
              : [`oci://${repoURL}/${chart}`],
          },
        ]
      : [],
  );
}

/** Argo CD's chart, at the version OpenTofu installs, with deploy/argocd's values. */
export function argocdChart(root = ROOT): RemoteChart | undefined {
  const version = /variable "argocd_version"[\s\S]*?default\s*=\s*"([^"]+)"/.exec(
    readFileSync(join(root, "infra/tofu/modules/bootstrap/variables.tf"), "utf8"),
  )?.[1];
  return version
    ? {
        name: "argocd",
        namespace: "argocd",
        version,
        values: join(root, "deploy/argocd/argo-cd-values.yaml"),
        source: ["argo-cd", "--repo", "https://argoproj.github.io/argo-helm"],
      }
    : undefined;
}

/** `helm template` of a remote chart (or `chart`, a local copy of it). */
export const remoteRender = (remote: RemoteChart, chart = remote.source) => [
  "template",
  remote.name,
  ...chart,
  "--version",
  remote.version,
  "--namespace",
  remote.namespace,
  "-f",
  remote.values,
];

/** Every add-on chart at its pinned version, with our values. */
function checkAddons({ root, exec, check }: Checks) {
  for (const addon of addonCharts(root)) {
    check(
      `${addon.name} ${addon.version} renders with our values`,
      exec("helm", remoteRender(addon)),
    );
  }
}

/**
 * Argo CD itself, at the version OpenTofu's bootstrap installs, with our values: the sops
 * plugin's ConfigMap and the repo server's sidecar must come out of them. Then Argo CD's
 * own manifests, validated.
 */
function checkArgocd({ root, exec, kubeconform, check, refuse }: Checks) {
  const argocd = argocdChart(root);
  if (argocd) {
    const result = exec("helm", remoteRender(argocd));
    const wired =
      result.ok &&
      [
        "name: argocd-cmp-cm",
        "sops.yaml:",
        "/var/run/argocd/argocd-cmp-server",
        "secretName: sops-age",
      ].every((line) => result.output.includes(line));
    check(`argo-cd ${argocd.version} renders with the sops plugin`, {
      ok: wired,
      output: result.ok
        ? "the sops plugin or its sidecar is missing from the output"
        : result.output,
    });
  } else {
    refuse("argocd_version not found in infra/tofu/modules/bootstrap/variables.tf");
  }

  const manifests = ["root.yaml", "projects.yaml", "repositories.yaml"]
    .map((file) => join("deploy/argocd", file))
    .concat(
      readdirSync(join(root, "deploy/argocd/appsets")).map((f) => `deploy/argocd/appsets/${f}`),
    )
    .map((file) => `---\n${readFileSync(join(root, file), "utf8")}`)
    .join("\n");
  check("Argo CD manifests are valid", kubeconform(manifests));
}

/** The directories that hold committed secrets: each environment's and the platform's. */
function secretDirectories(root: string) {
  const environments = join(root, "deploy/environments");
  const platform = join(root, "deploy/platform/secrets");
  return [
    ...readdirSync(environments).map((env) => ({
      dir: join(environments, env, "secrets"),
      platform: false,
    })),
    ...(existsSync(platform)
      ? readdirSync(platform).map((env) => ({ dir: join(platform, env), platform: true }))
      : []),
  ].filter(({ dir }) => existsSync(dir));
}

/** Every file in a secrets directory is a SOPS-encrypted Secret. */
function checkSecrets({ root, check }: Checks) {
  const secretDirs = secretDirectories(root);
  const problems: string[] = [];
  const sopsConfig = readFileSync(join(root, ".sops.yaml"), "utf8");
  for (const { dir, platform } of secretDirs) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name).slice(root.length + 1);
      const problem = entry.isFile()
        ? unsafeSecret(
            entry.name,
            readFileSync(join(dir, entry.name), "utf8"),
            platform,
            recipientsFor(path, sopsConfig),
          )
        : "not a file";
      if (problem) {
        problems.push(`${path}: ${problem}`);
      }
    }
  }
  check(`every committed secret is SOPS-encrypted (${secretDirs.length} directories)`, {
    ok: problems.length === 0,
    output: problems.join("\n"),
  });
}

/** Checks the charts, environments, platform and secrets under `root`; the exit code. */
export function charts({ run = runSync, root = ROOT } = {}): number {
  let failed = false;
  const exec: Checks["exec"] = (command, args, input) => {
    const result = run(command, args, { input, cwd: root });
    return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
  };
  const refuse = (message: string) => {
    failed = true;
    fail(message);
  };
  const checks: Checks = {
    root,
    exec,
    kubeconform: kubeconformWith(exec, root),
    check: (label, result) => {
      if (result.ok) {
        return ok(label);
      }
      refuse(label);
      console.error(result.output.trim());
    },
    refuse,
  };
  for (const section of [
    checkOwnCharts,
    checkEnvironments,
    checkOptional,
    checkPlatform,
    checkAddons,
    checkArgocd,
    checkSecrets,
  ]) {
    section(checks);
  }
  return failed ? 1 : 0;
}

await runMain(import.meta, charts);
