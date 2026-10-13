/**
 * The ApplicationSets in deploy/argocd/appsets, read from the files: what Argo CD can't
 * tell us until a cluster syncs them.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const APPSETS = join(ROOT, "deploy/argocd/appsets");

type AppSetGenerator = Record<string, unknown> & {
  matrix?: { generators: AppSetGenerator[] };
  git?: { pathParamPrefix?: string; files?: { path: string }[] };
};

const appsets = readdirSync(APPSETS).map((file) => ({
  file,
  spec: (
    Bun.YAML.parse(readFileSync(join(APPSETS, file), "utf8")) as {
      spec: { generators: AppSetGenerator[] };
    }
  ).spec,
}));

type GitGenerator = NonNullable<AppSetGenerator["git"]>;

function* gitGenerators(generators: AppSetGenerator[]): Generator<GitGenerator> {
  for (const generator of generators) {
    if (generator.git) {
      yield generator.git;
    }
    if (generator.matrix) {
      yield* gitGenerators(generator.matrix.generators);
    }
  }
}

/** The files a git generator's glob matches; a templated segment matches any name. */
function matched(glob: string) {
  const pattern = glob.replace(/\{\{[^}]*\}\}/g, "*");
  return [...new Bun.Glob(pattern).scanSync({ cwd: ROOT })].map(
    (file) => Bun.YAML.parse(readFileSync(join(ROOT, file), "utf8")) as object,
  );
}

describe("git file generators", () => {
  it("keep a file's own `path` key, which the generator's path parameter would replace", () => {
    for (const { file, spec } of appsets) {
      for (const git of gitGenerators(spec.generators)) {
        const clashes = (git.files ?? []).some((f) =>
          matched(f.path).some((values) => "path" in values),
        );
        if (clashes) {
          expect({ file, prefix: git.pathParamPrefix }).toEqual({ file, prefix: "file" });
        }
      }
    }
  });
});

describe("what each environment deploys", () => {
  const read = (file: string) =>
    Bun.YAML.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, unknown>;
  const patchOf = (file: string) =>
    (read(`deploy/argocd/appsets/${file}`) as { spec: { templatePatch: string } }).spec
      .templatePatch;

  it("is read at the revision in the environment's release.yaml: charts, values, Secrets, add-ons", () => {
    for (const file of ["envs.yaml", "platform.yaml", "observability.yaml"]) {
      const text = readFileSync(join(APPSETS, file), "utf8");
      expect(text).toContain(
        "path: 'deploy/environments/{{ index .metadata.labels \"boilerplate.dev/environment\" }}/release.yaml'",
      );
      const ours = [...patchOf(file).matchAll(/boilerplate\.git\n\s+targetRevision: (.+)/g)];
      expect(ours.length).toBeGreaterThan(0);
      for (const [, revision] of ours) {
        expect(revision).toBe('"{{ .revision }}"');
      }
    }
  });

  it("runs production's images from its release.yaml", () => {
    expect(patchOf("envs.yaml")).toMatch(
      /\{\{- if hasKey \. "imageTag" \}\}\s+- name: image\.tag\s+value: \{\{ \.imageTag \| quote \}\}/,
    );
  });

  it("has a release.yaml per environment: staging follows master", () => {
    expect(read("deploy/environments/staging/release.yaml")).toEqual({ revision: "HEAD" });
    expect(read("deploy/environments/production/release.yaml")).toHaveProperty("revision");
  });
});

describe("the add-ons' order", () => {
  const waves = (dir: string) =>
    readdirSync(join(ROOT, dir))
      .filter((file) => file.endsWith(".yaml"))
      .map(
        (file) =>
          (Bun.YAML.parse(readFileSync(join(ROOT, dir, file), "utf8")) as { wave: string }).wave,
      );
  const steps = (file: string) =>
    (
      Bun.YAML.parse(readFileSync(join(APPSETS, file), "utf8")) as {
        spec: {
          strategy: { rollingSync: { steps: { matchExpressions: { values: string[] }[] }[] } };
        };
      }
    ).spec.strategy.rollingSync.steps.flatMap((step) => step.matchExpressions[0]?.values ?? []);

  it.each([
    ["platform.yaml", "deploy/platform/addons"],
    ["observability.yaml", "deploy/platform/addons/observability"],
  ])("%s rolls out every wave of %s, in order", (appset, dir) => {
    const expected = [...new Set(waves(dir))]
      .sort((a, b) => Number(a) - Number(b))
      .map((w) => `wave${w}`);
    expect(steps(appset)).toEqual(expected);
  });
});

describe("the cluster facts the add-ons read", () => {
  const files = [
    ...new Bun.Glob("deploy/platform/addons/**/*.yaml").scanSync({ cwd: ROOT }),
  ].sort();
  const fields = files.flatMap((file) =>
    Object.values(
      (
        Bun.YAML.parse(readFileSync(join(ROOT, file), "utf8")) as {
          clusterParameters?: Record<string, string>;
        }
      ).clusterParameters ?? {},
    ).map((given) => given.split("|")[0] ?? ""),
  );
  // What OpenTofu writes on the cluster's Argo CD Secret (envs/k3s, cluster_annotations).
  const main = readFileSync(join(ROOT, "infra/tofu/envs/k3s/main.tf"), "utf8");
  const block = main.slice(main.indexOf("cluster_annotations = merge("));
  const written = new Set(
    [...block.slice(0, block.indexOf("\n  )\n")).matchAll(/"?([a-z][a-z-]*)"?\s+=/g)].map(
      (match) => match[1],
    ),
  );

  it("are each a name, a label or an annotation OpenTofu writes", () => {
    expect(fields.length).toBeGreaterThan(10);
    const unknown = fields.filter(
      (field) => field !== "name" && !field.startsWith("label:") && !written.has(field),
    );
    expect(unknown).toEqual([]);
  });

  it("fall back the same way in both ApplicationSets that read them", () => {
    for (const file of ["platform.yaml", "observability.yaml"]) {
      expect(readFileSync(join(APPSETS, file), "utf8")).toContain(
        "{{- $value = $value | default $fallback }}",
      );
    }
  });
});
