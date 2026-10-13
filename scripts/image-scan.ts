/**
 * Known vulnerabilities in the third-party images we run: `bun scripts/image-scan.ts`,
 * the Security workflow's "Third-party images" job and the pre-push runner, or
 * `bun scripts/image-scan.ts <ref>…` for some of them. The list isn't kept by hand: it's
 * every image the rendered manifests run (deploy/.rendered, which scripts/misconfig.ts
 * renders: our charts for every environment, the platform's, the add-ons' and Argo CD's,
 * including images an operator is told to start, like cert-manager's ACME solver), every
 * image named in deploy/ and compose, and the dev container as it builds. Our own images
 * are left to CI's Container images jobs. Each goes through Trivy's image scan: a fixable
 * critical or high vulnerability fails.
 *
 * An image named by tag is resolved to its digest first, and scanned at that digest, so
 * the result says exactly what was scanned. A digest that passed today, with the same
 * reviewed exceptions, isn't scanned again (~/.cache/boilerplate/image-scan); Trivy keeps
 * its database and the image layers it read in its own cache. The images are read from
 * their registries, one at a time, never pulled into Docker; the dev container is built
 * (Docker's cache keeps that quick) since its Dockerfile updates what its base ships.
 *
 * A vulnerability with no fixed image upstream yet is a reviewed exception in that
 * image's own file under .trivyignores/ (<repository>.yaml), each entry with its reason
 * and an expiry: once it passes, the scan fails again, so someone looks for the rebuilt
 * image. Trivy: a local one of CI's version, else its image in Docker; with neither, it
 * fails and says how to get one.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fail, ok, ROOT, type Run, runMain, runSync } from "./lib";
import { RENDERED, renderCharts, TRIVY_VERSION } from "./misconfig";

/** An image reference in a manifest, values file or compose file, with its tag. */
const IMAGE = /^\s*(?:-\s+)?(?:image|imageName|imageRef):\s*["']?([^\s"'{]+:[^\s"']+)["']?\s*$/gm;

/** What the dev container builds as, to be scanned. */
export const DEVCONTAINER = "boilerplate/devcontainer:dev";

/** The files that name images: deploy/'s YAML (not tests or renders) and compose's. */
export function imageFiles(root = ROOT) {
  return [
    ...readdirSync(join(root, "deploy"), { recursive: true, encoding: "utf8" })
      .filter((path) => /\.ya?ml$/.test(path) && !/(^|\/)(\.rendered|tests)\//.test(path))
      .map((path) => join("deploy", path)),
    ...readdirSync(root).filter((file) => /^docker-compose.*\.ya?ml$/.test(file)),
  ];
}

/** Every image reference in `files` (under `root`), as `file: reference`. */
export const imageReferences = (root = ROOT, files = imageFiles(root)) =>
  files.flatMap((file) =>
    [...readFileSync(join(root, file), "utf8").matchAll(IMAGE)].map((m) => `${file}: ${m[1]}`),
  );

/**
 * Where a rendered manifest names an image: a container's `image:` (or CloudNativePG's
 * `imageName:`), an operator's flag for the image it starts (`--acme-http01-solver-image=`,
 * `--prometheus-config-reloader=`), or a setting ending in _IMAGE.
 */
const RENDERED_IMAGE =
  /(?:^\s*(?:-\s+)?(?:image|imageName):\s*|--[a-z0-9-]*(?:-image|config-reloader)=|_IMAGE:\s*)["']?([a-z0-9][^\s"'{}]*:[^\s"']+)/gm;

/**
 * Flags naming an image for a feature that's off, so nothing runs it: the Prometheus
 * operator's Thanos sidecar.
 */
const NOT_RUN = ["--thanos-default-base-image="];

/** Every image the rendered manifests (deploy/.rendered, scripts/misconfig.ts) run. */
export function renderedImages(root = ROOT) {
  const dir = join(root, RENDERED);
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".yaml"))
    .flatMap((path) =>
      readFileSync(join(dir, path), "utf8")
        .split("\n")
        .filter((line) => !NOT_RUN.some((flag) => line.includes(flag)))
        .flatMap((line) => [...line.matchAll(RENDERED_IMAGE)].map((m) => m[1] ?? "")),
    );
}

/** Our own images' registry (the stack chart's), which CI's Container images jobs scan. */
function ownRegistry(root: string) {
  const values = readFileSync(join(root, "deploy/charts/stack/values.yaml"), "utf8");
  return /^ {2}registry: (\S+)$/m.exec(values)?.[1] ?? "";
}

/**
 * The third-party images, each once: everything the renders run and deploy/ and compose
 * name, without our own (built locally as :dev, or ours in the registry).
 */
export function thirdPartyImages(root = ROOT) {
  const own = `${ownRegistry(root)}/`;
  const images = [
    ...renderedImages(root),
    ...imageReferences(root).map((line) => line.slice(line.indexOf(": ") + 2)),
  ]
    .filter((ref) => !ref.endsWith(":dev") && !ref.startsWith(own))
    .map((ref) => ref.replace(/^docker\.io\//, ""));
  return [...new Set(images)].sort();
}

/** `ref` at its digest: as given when it has one, else its tag resolved by the registry. */
export function atDigest(run: Run, ref: string) {
  if (/@sha256:[0-9a-f]{64}$/.test(ref)) {
    return ref;
  }
  const inspected = run("docker", [
    "buildx",
    "imagetools",
    "inspect",
    ref,
    "--format",
    "{{json .Manifest.Digest}}",
  ]);
  const digest = /"(sha256:[0-9a-f]{64})"/.exec(inspected.stdout)?.[1];
  return inspected.status === 0 && digest ? `${ref}@${digest}` : undefined;
}

/**
 * Where a scan's pass is kept: by the image's digest, its reviewed exceptions and the
 * day (Trivy's database changes daily), so the same image isn't scanned twice a day.
 */
export function passFile(results: string, root: string, ref: string, day: string) {
  const ignores = ignoreFile(root, ref);
  const exceptions = existsSync(ignores) ? readFileSync(ignores, "utf8") : "";
  const key = createHash("sha256").update(`${ref}\n${exceptions}\n${day}`).digest("hex");
  return join(results, `${key}.pass`);
}

/** An image's reviewed exceptions: .trivyignores/<repository, without tag or digest>.yaml. */
export function ignoreFile(root: string, ref: string) {
  const repository = ref
    .replace(/^docker\.io\//, "")
    .replace(/@.*$/, "")
    .replace(/:[^/:]*$/, "");
  return join(root, ".trivyignores", `${repository}.yaml`);
}

type Trivy = (args: string[]) => [string, string[]];

/** How Trivy runs here, or undefined with neither a local one of CI's version nor Docker. */
function trivyWith(run: Run, root: string, cache: string): Trivy | undefined {
  if (run("trivy", ["--version"], { cwd: root }).stdout.includes(`Version: ${TRIVY_VERSION}\n`)) {
    return (args) => ["trivy", [...args, "--cache-dir", cache]];
  }
  if (run("docker", ["info"], { cwd: root, stdio: "ignore" }).status === 0) {
    // The Docker socket: the dev container is scanned from Docker's images.
    const image = ["run", "--rm", "--memory=1g", "-v", `${root}:${root}:ro`];
    const socket = ["-v", "/var/run/docker.sock:/var/run/docker.sock"];
    const cached = ["-v", `${cache}:/root/.cache/trivy`, `aquasec/trivy:${TRIVY_VERSION}`];
    return (args) => ["docker", [...image, ...socket, ...cached, ...args]];
  }
  return undefined;
}

/** Trivy's arguments for scanning `ref` from `source` (registry or docker). */
function scanArgs(root: string, ref: string, source: "remote" | "docker") {
  const ignores = ignoreFile(root, ref);
  return [
    "image",
    "--quiet",
    // Vulnerabilities only: a third-party image's own files (Debian's snake-oil TLS key
    // in Postgres's, say) aren't secrets of ours.
    "--scanners",
    "vuln",
    "--exit-code",
    "1",
    "--ignore-unfixed",
    "--severity",
    "CRITICAL,HIGH",
    ...(existsSync(ignores) ? ["--ignorefile", ignores] : []),
    "--image-src",
    source,
    // A mirror of Trivy's vulnerability database without GHCR's rate limit (as CI's).
    "--db-repository",
    "mirror.gcr.io/aquasec/trivy-db",
    ref,
  ];
}

type Scan = { ref: string; source: "remote" | "docker" };
type Context = { run: Run; root: string; trivy: Trivy; results: string; day: string };

/** One image scanned at its digest, or found passed today; whether it passes. */
function scanOne({ run, root, trivy, results, day }: Context, { ref, source }: Scan) {
  const pinned = source === "docker" ? ref : atDigest(run, ref);
  if (!pinned) {
    fail(`${ref}: its registry didn't say which image the tag is`);
    return false;
  }
  // The dev container is built here, so it has no digest yet: never cached.
  const passed = source === "remote" ? passFile(results, root, pinned, day) : undefined;
  if (passed && existsSync(passed)) {
    ok(`${pinned} (passed today)`);
    return true;
  }
  const [command, args] = trivy(scanArgs(root, pinned, source));
  if (run(command, args, { cwd: root, stdio: "inherit" }).status !== 0) {
    fail(pinned);
    return false;
  }
  if (passed) {
    writeFileSync(passed, `${pinned}\n`);
  }
  ok(pinned);
  return true;
}

/**
 * Scans `images` (every third-party image, and the dev container, by default); the exit
 * code.
 */
export function imageScan(
  images = process.argv.slice(2),
  run = runSync,
  root = ROOT,
  cache = join(homedir(), ".cache/boilerplate/trivy"),
  results = join(homedir(), ".cache/boilerplate/image-scan"),
  day = new Date().toISOString().slice(0, 10),
): number {
  // The renders the list comes from, as they are now.
  if (images.length === 0 && !renderCharts(run, root)) {
    return 1;
  }
  const trivy = trivyWith(run, root, cache);
  if (!trivy) {
    fail(
      `Trivy ${TRIVY_VERSION} isn't installed and Docker isn't running: install that version (https://github.com/aquasecurity/trivy/releases) or start Docker`,
    );
    return 1;
  }
  const scans: Scan[] = (images.length > 0 ? images : thirdPartyImages(root)).map((ref) => ({
    ref,
    source: "remote",
  }));
  if (images.length === 0) {
    const built = run("docker", ["build", "--quiet", "-t", DEVCONTAINER, ".devcontainer"], {
      cwd: root,
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (built.status !== 0) {
      fail("Couldn't build the dev container (Docker's output is above), so it isn't scanned");
      return 1;
    }
    scans.push({ ref: DEVCONTAINER, source: "docker" });
  }
  mkdirSync(results, { recursive: true });
  const failed = scans.flatMap((scan) => {
    const result = scanOne({ run, root, trivy, results, day }, scan);
    return result ? [] : [scan.ref];
  });
  if (failed.length > 0) {
    fail(
      `${failed.length} of ${scans.length} images have a fixable critical or high vulnerability`,
    );
    return 1;
  }
  return 0;
}

await runMain(import.meta, imageScan);
