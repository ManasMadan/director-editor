/**
 * The devcontainer has every tool shipping needs (docs/new-project.md, "Tools"), each
 * pinned, within Renovate's reach and checked against a checksum per architecture, at the
 * versions CI uses where CI has one too.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const dockerfile = read(".devcontainer/Dockerfile");

/** Each downloaded tool: its version argument, and its name in the checksum table. */
const TOOLS = {
  KIND: "kind",
  HELM_UNITTEST: "unittest",
  SOPS: "sops",
  AGE: "age",
  GH: "gh",
};

/** The checksums the table pins for one architecture. */
function checksums(arch: string) {
  const block = new RegExp(`${arch}\\) \\\\\\n([\\s\\S]*?);;`).exec(dockerfile)?.[1] ?? "";
  return Object.fromEntries([...block.matchAll(/(\w+)=([0-9a-f]+)/g)].map(([, k, v]) => [k, v]));
}

const version = (name: string) => new RegExp(`ARG ${name}_VERSION=(\\S+)`).exec(dockerfile)?.[1];

describe("the devcontainer", () => {
  it("has every tool docs/new-project.md lists for shipping", () => {
    const docs = read("docs/new-project.md");
    expect(docs).not.toContain("the devcontainer has only");
    for (const tool of ["gh", "sops", "age", "tofu", "helm", "kind", "kubectl"]) {
      expect(docs).toContain(`\`${tool}\``);
    }
    expect(dockerfile).toContain("COPY --from=tofu");
    const features = read(".devcontainer/devcontainer.json");
    expect(features).toContain("kubectl-helm-minikube");
    for (const [name, table] of Object.entries(TOOLS)) {
      expect({ name, version: version(name) }).toEqual({
        name,
        version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      });
      expect(dockerfile).toContain(`"$${table}"`);
    }
  });

  it("pins each with a renovate comment, the line before its version", () => {
    for (const name of Object.keys(TOOLS)) {
      expect(dockerfile).toMatch(
        new RegExp(`# renovate: datasource=github-releases depName=\\S+\\nARG ${name}_VERSION=`),
      );
    }
  });

  it("checks each download against a SHA-256 for both architectures", () => {
    for (const arch of ["amd64", "arm64"]) {
      const sums = checksums(arch);
      expect(Object.keys(sums).sort()).toEqual(Object.values(TOOLS).sort());
      for (const sum of Object.values(sums)) {
        expect(sum).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    expect(dockerfile).toContain('echo "$3  $1" | sha256sum -c -');
    expect(dockerfile).toContain('*) echo "No checksums for $TARGETARCH" >&2; exit 1 ;;');
  });

  it("has the kind and helm-unittest CI uses", () => {
    const kind = read(".github/workflows/kind.yml");
    expect(kind).toContain(`VERSION: v${version("KIND")}\n`);
    expect(kind).toContain(`SHA256: ${checksums("amd64").kind}\n`);
    expect(read(".github/workflows/ci.yml")).toContain(`VERSION: v${version("HELM_UNITTEST")}\n`);
  });
});
