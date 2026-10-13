import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atDigest,
  DEVCONTAINER,
  ignoreFile,
  imageFiles,
  imageReferences,
  imageScan,
  passFile,
  renderedImages,
  thirdPartyImages,
} from "./image-scan";
import { ROOT } from "./lib";
import { RENDERED, TRIVY_VERSION } from "./misconfig";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

const VALKEY = `valkey/valkey:9.1.2-alpine@sha256:${"a".repeat(64)}`;

/** A checkout naming images in values, a test, a compose file and the dev container. */
function checkout() {
  const root = mkdtempSync(join(tmpdir(), "image-scan-"));
  mkdirSync(join(root, "deploy/charts/data/tests"), { recursive: true });
  mkdirSync(join(root, ".devcontainer"));
  writeFileSync(
    join(root, "deploy/charts/data/values.yaml"),
    `valkey:\n  image: docker.io/${VALKEY}\n  # image: commented/out:1\n  imageName: "ghcr.io/x/pg:18@sha256:${"b".repeat(64)}"\n`,
  );
  writeFileSync(join(root, "deploy/charts/data/tests/t.yaml"), "image: test/only:1\n");
  writeFileSync(
    join(root, "docker-compose.yml"),
    `services:\n  valkey:\n    image: ${VALKEY}\n  app:\n    image: boilerplate/api:dev\n`,
  );
  writeFileSync(
    join(root, ".devcontainer/Dockerfile"),
    `FROM oven/bun:1@sha256:${"c".repeat(64)} AS bun\nFROM base:2@sha256:${"d".repeat(64)}\n`,
  );
  // What the renders need: our registry, no environments, no add-ons, no Argo CD.
  mkdirSync(join(root, "deploy/charts/stack"), { recursive: true });
  writeFileSync(
    join(root, "deploy/charts/stack/values.yaml"),
    "image:\n  registry: ghcr.io/us/app\n",
  );
  mkdirSync(join(root, "deploy/environments"));
  mkdirSync(join(root, "deploy/platform/addons/observability"), { recursive: true });
  mkdirSync(join(root, "infra/tofu/modules/bootstrap"), { recursive: true });
  writeFileSync(join(root, "infra/tofu/modules/bootstrap/variables.tf"), "");
  mkdirSync(join(root, RENDERED));
  return root;
}

/** A render naming images every way the manifests do. */
const RENDER = [
  "        - name: app",
  "          image: quay.io/team/app:v1",
  '          image: "docker.io/team/quoted:2"',
  "          image: ghcr.io/us/app/api:sha-1",
  `  imageName: ghcr.io/x/pg:18@sha256:${"b".repeat(64)}`,
  "            - --acme-http01-solver-image=quay.io/jetstack/solver:v1",
  "            - --prometheus-config-reloader=quay.io/po/reloader:v2",
  "            - --thanos-default-base-image=quay.io/thanos/thanos:v3",
  '  SIDECAR_IMAGE: "ghcr.io/team/sidecar:v4"',
  "          imagePullPolicy: IfNotPresent",
  "",
].join("\n");

describe("the third-party images", () => {
  it("are every image the renders run and deploy/ and compose name, each once, ours aside", () => {
    const root = checkout();
    writeFileSync(join(root, RENDERED, "a.yaml"), RENDER);
    mkdirSync(join(root, RENDERED, "isolated/LimitRange"), { recursive: true });
    writeFileSync(join(root, RENDERED, "isolated/LimitRange/b.yaml"), "image: team/other:5\n");
    expect(imageFiles(root).sort()).toEqual([
      "deploy/charts/data/values.yaml",
      "deploy/charts/stack/values.yaml",
      "docker-compose.yml",
    ]);
    expect(imageReferences(root)).toHaveLength(4);
    expect(thirdPartyImages(root)).toEqual([
      "ghcr.io/team/sidecar:v4",
      `ghcr.io/x/pg:18@sha256:${"b".repeat(64)}`,
      "quay.io/jetstack/solver:v1",
      "quay.io/po/reloader:v2",
      "quay.io/team/app:v1",
      "team/other:5",
      "team/quoted:2",
      VALKEY,
    ]);
  });

  // The list is the renders', not a hand-kept one: any image a render names is scanned,
  // the day it first appears (the Thanos image of a feature that's off aside).
  it("leave out no image a render names", () => {
    const root = checkout();
    writeFileSync(join(root, RENDERED, "a.yaml"), RENDER);
    const named = [...RENDER.matchAll(/[a-z0-9.]+\/[\w./-]+:[\w.-]+(?:@sha256:[0-9a-f]+)?/g)]
      .map((m) => m[0].replace(/^docker\.io\//, ""))
      .filter((ref) => !ref.startsWith("ghcr.io/us/") && !ref.includes("thanos"));
    const scanned = thirdPartyImages(root);
    expect(named.filter((ref) => !scanned.includes(ref))).toEqual([]);
    expect(renderedImages(root)).toContain("ghcr.io/us/app/api:sha-1");
  });
});

describe("an image's digest", () => {
  it("is the one it names, or its tag's, as its registry answers", () => {
    const digest = `sha256:${"e".repeat(64)}`;
    expect(atDigest(fakeRun().run, `a/b:1@${digest}`)).toBe(`a/b:1@${digest}`);
    const { run, calls } = fakeRun(() => ({ stdout: `"${digest}"\n` }));
    expect(atDigest(run, "a/b:1")).toBe(`a/b:1@${digest}`);
    expect(calls).toEqual([
      "docker buildx imagetools inspect a/b:1 --format {{json .Manifest.Digest}}",
    ]);
    expect(atDigest(fakeRun(() => ({ status: 1 })).run, "a/b:1")).toBeUndefined();
  });
});

describe("the reviewed exceptions", () => {
  // Each one is a wait for an upstream rebuild: it says what and why, and it lapses soon,
  // so the scan fails again and someone looks.
  it("name the vulnerability, say why, and expire within two months", () => {
    const files = readdirSync(join(ROOT, ".trivyignores"), {
      recursive: true,
      encoding: "utf8",
    }).filter((path) => path.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(0);
    const latest = Date.now() + 62 * 24 * 60 * 60 * 1000;
    for (const file of files) {
      const { vulnerabilities } = Bun.YAML.parse(
        readFileSync(join(ROOT, ".trivyignores", file), "utf8"),
      ) as { vulnerabilities: { id?: string; statement?: string; expired_at?: string }[] };
      for (const entry of vulnerabilities) {
        expect({ file, ok: Boolean(entry.id && entry.statement && entry.expired_at) }).toEqual({
          file,
          ok: true,
        });
        expect(new Date(String(entry.expired_at)).getTime()).toBeLessThanOrEqual(latest);
      }
    }
  });

  it("are found by image repository, whatever the tag or digest", () => {
    expect(ignoreFile("/r", `docker.io/clamav/clamav-debian:1.5.4@sha256:${"a".repeat(64)}`)).toBe(
      "/r/.trivyignores/clamav/clamav-debian.yaml",
    );
    expect(ignoreFile("/r", "registry:5000/team/app:2")).toBe(
      "/r/.trivyignores/registry:5000/team/app.yaml",
    );
  });
});

describe("the image scan", () => {
  const trivy = (line: string) =>
    line === "trivy --version" ? { stdout: `Version: ${TRIVY_VERSION}\n` } : undefined;

  it("scans each image at its digest and the dev container as built, failing on any", () => {
    const printed = captureOutput();
    const root = checkout();
    mkdirSync(join(root, ".trivyignores/ghcr.io/x"), { recursive: true });
    writeFileSync(join(root, ".trivyignores/ghcr.io/x/pg.yaml"), "vulnerabilities: []\n");
    const results = mkdtempSync(join(tmpdir(), "results-"));
    const { run, calls } = fakeRun((line) => {
      if (line.startsWith("helm template")) {
        return { stdout: "      image: quay.io/team/app:v1\n" };
      }
      if (line.startsWith("docker buildx imagetools inspect quay.io/team/app:v1")) {
        return { stdout: `"sha256:${"f".repeat(64)}"` };
      }
      return trivy(line) ?? (line.includes("ghcr.io/x/pg") ? { status: 1 } : {});
    });
    expect(imageScan([], run, root, "/cache", results, "2026-10-06")).toBe(1);
    expect(calls).toContain(`docker build --quiet -t ${DEVCONTAINER} .devcontainer`);
    const scans = calls.filter((line) => line.startsWith("trivy image"));
    expect(scans).toHaveLength(4);
    // Its own reviewed exceptions, when it has any.
    expect(scans[0]).toBe(
      `trivy image --quiet --scanners vuln --exit-code 1 --ignore-unfixed --severity CRITICAL,HIGH --ignorefile ${root}/.trivyignores/ghcr.io/x/pg.yaml --image-src remote --db-repository mirror.gcr.io/aquasec/trivy-db ghcr.io/x/pg:18@sha256:${"b".repeat(64)} --cache-dir /cache`,
    );
    // A tag, scanned at the digest its registry gave.
    expect(scans[1]).toEndWith(` quay.io/team/app:v1@sha256:${"f".repeat(64)} --cache-dir /cache`);
    expect(scans[2]).not.toContain("--ignorefile");
    expect(scans[3]).toContain(
      `--image-src docker --db-repository mirror.gcr.io/aquasec/trivy-db ${DEVCONTAINER}`,
    );
    expect(printed()).toContain("1 of 4 images have a fixable critical or high vulnerability");
  });

  it("scans a digest that passed today once, and again the next day", () => {
    const printed = captureOutput();
    const root = checkout();
    const results = mkdtempSync(join(tmpdir(), "results-"));
    const ref = `a/b:1@sha256:${"a".repeat(64)}`;
    const first = fakeRun((line) => trivy(line));
    expect(imageScan([ref], first.run, root, "/cache", results, "2026-10-06")).toBe(0);
    expect(readdirSync(results)).toHaveLength(1);
    const again = fakeRun((line) => trivy(line));
    expect(imageScan([ref], again.run, root, "/cache", results, "2026-10-06")).toBe(0);
    expect(again.calls.some((line) => line.startsWith("trivy image"))).toBe(false);
    expect(printed()).toContain(`${ref} (passed today)`);
    const tomorrow = fakeRun((line) => trivy(line));
    expect(imageScan([ref], tomorrow.run, root, "/cache", results, "2026-10-07")).toBe(0);
    expect(tomorrow.calls.some((line) => line.startsWith("trivy image"))).toBe(true);
    // New reviewed exceptions: scanned again too.
    expect(passFile(results, root, ref, "2026-10-06")).toBe(
      passFile(results, root, ref, "2026-10-06"),
    );
    mkdirSync(join(root, ".trivyignores/a"), { recursive: true });
    writeFileSync(join(root, ".trivyignores/a/b.yaml"), "vulnerabilities: []\n");
    expect(existsSync(passFile(results, root, ref, "2026-10-06"))).toBe(false);
  });

  it("fails an image whose tag its registry can't resolve", () => {
    const printed = captureOutput();
    const root = checkout();
    const { run } = fakeRun((line) =>
      line.startsWith("docker buildx") ? { status: 1 } : trivy(line),
    );
    expect(imageScan(["a/b:1"], run, root, "/cache", mkdtempSync(join(tmpdir(), "r-")))).toBe(1);
    expect(printed()).toContain("a/b:1: its registry didn't say which image the tag is");
  });

  it("stops when the charts don't render", () => {
    captureOutput();
    spyOn(process.stderr, "write").mockImplementation(() => true);
    const { run, calls } = fakeRun((line) =>
      line.startsWith("helm template") ? { status: 1 } : trivy(line),
    );
    expect(imageScan([], run, checkout(), "/cache")).toBe(1);
    expect(calls.some((line) => line.startsWith("trivy"))).toBe(false);
  });

  it("stops when the dev container doesn't build", () => {
    const printed = captureOutput();
    const { run, calls } = fakeRun(
      (line) => trivy(line) ?? (line.startsWith("docker build") ? { status: 1 } : {}),
    );
    expect(imageScan([], run, checkout(), "/cache", mkdtempSync(join(tmpdir(), "r-")))).toBe(1);
    expect(printed()).toContain("Couldn't build the dev container");
    expect(calls.some((line) => line.startsWith("trivy image"))).toBe(false);
  });

  it("scans only the images it's given, through Trivy's image when there's no local one", () => {
    captureOutput();
    const { run, calls } = fakeRun((line) => {
      if (line === "trivy --version") {
        return { status: null };
      }
      return line.startsWith("docker buildx") ? { stdout: `"sha256:${"1".repeat(64)}"` } : {};
    });
    expect(imageScan(["a/b:1"], run, "/repo", "/cache", mkdtempSync(join(tmpdir(), "r-")))).toBe(0);
    expect(calls.at(-1)).toStartWith(
      `docker run --rm --memory=1g -v /repo:/repo:ro -v /var/run/docker.sock:/var/run/docker.sock -v /cache:/root/.cache/trivy aquasec/trivy:${TRIVY_VERSION} image `,
    );
    expect(calls.at(-1)).toEndWith(` a/b:1@sha256:${"1".repeat(64)}`);
  });

  it("fails rather than skipping when there's neither Trivy nor Docker", () => {
    const printed = captureOutput();
    expect(imageScan(["a/b:1"], fakeRun(() => ({ status: 1 })).run, "/repo")).toBe(1);
    expect(printed()).toContain("isn't installed and Docker isn't running");
  });

  it("is in the Security workflow, weekly too, against the same Trivy", () => {
    const security = readFileSync(join(ROOT, ".github/workflows/security.yml"), "utf8");
    const job = security.slice(security.indexOf("  images:"), security.indexOf("  security-ok:"));
    expect(job).toContain("run: bun scripts/image-scan.ts\n");
    expect(job).toContain(`version: v${TRIVY_VERSION}\n`);
    expect(security).toMatch(/needs: \[[^\]]*\bimages\b[^\]]*\]/);
  });
});
