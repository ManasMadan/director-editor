/**
 * Deletes everything this repo created in Docker, and nothing else:
 * `bun run docker:clean`.
 *
 *   - the compose project "boilerplate": its containers, networks and volumes (the local
 *     database, queues, stored files and emails)
 *   - the kind cluster "boilerplate" (`bun run k8s:up`)
 *   - the "boilerplate" image builder and its build cache
 *   - the images: ours (boilerplate/*), the services' (docker-compose.yml), the
 *     tools' the scripts run (Playwright, k6, kubeconform), and the devcontainer's (the
 *     image VS Code builds and what .devcontainer/Dockerfile builds it from)
 *
 * An image another container still uses is left alone, so nothing outside this repo
 * loses what it runs on.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ok, ROOT, runMain, runSync, warn } from "./lib";

const CLUSTER = "boilerplate";
const BUILDER = "boilerplate";
/** Images the repo's scripts run directly (keep in sync with them). */
const TOOL_IMAGES = [
  "mcr.microsoft.com/playwright:v1.63.0-noble",
  "grafana/k6:2.3.0",
  "ghcr.io/yannh/kubeconform:v0.7.0",
  // The builder's own image (k8s:up builds in a "boilerplate" buildx builder).
  "moby/buildkit:buildx-stable-1",
];

/** The images .devcontainer/Dockerfile builds from (its FROM lines, minus stage names). */
const devcontainerBases = [
  ...readFileSync(join(ROOT, ".devcontainer/Dockerfile"), "utf8").matchAll(/^FROM (\S+)/gm),
].map((match) => match[1] ?? "");
const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** Deletes what the repo created in Docker (and kind), reporting each step. */
export function cleanDocker(run = runSync) {
  const docker = (args: string[]) => {
    const result = run("docker", args, { cwd: ROOT });
    return { ok: result.status === 0, stdout: result.stdout };
  };

  const down = run(
    "docker",
    ["compose", "--profile", "full", "down", "--volumes", "--remove-orphans"],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (down.status === 0) {
    ok("local services, their networks and volumes");
  }

  const kind = run("kind", ["get", "clusters"]);
  if (kind.status === 0 && lines(kind.stdout).includes(CLUSTER)) {
    run("kind", ["delete", "cluster", "--name", CLUSTER], { stdio: "inherit" });
    ok(`kind cluster ${CLUSTER}`);
  }

  if (docker(["buildx", "inspect", BUILDER]).ok) {
    docker(["buildx", "rm", "--force", BUILDER]);
    ok(`image builder ${BUILDER} and its cache`);
  }

  const named = (reference: string) =>
    lines(
      docker([
        "images",
        "--format",
        "{{.Repository}}:{{.Tag}}",
        "--filter",
        `reference=${reference}`,
      ]).stdout,
    );
  const images = new Set([
    ...named("boilerplate/*"),
    ...lines(docker(["compose", "--profile", "full", "config", "--images"]).stdout),
    ...TOOL_IMAGES,
    ...devcontainerBases,
    // VS Code names the devcontainer's image after the folder: vsc-boilerplate-<hash>.
    ...named("vsc-boilerplate-*"),
    // kind's node image, once no cluster uses it.
    ...named("kindest/node"),
  ]);
  for (const image of [...images].sort()) {
    if (!docker(["image", "inspect", image]).ok) {
      continue;
    }
    const users = lines(
      docker(["ps", "-a", "--filter", `ancestor=${image}`, "--format", "{{.Names}}"]).stdout,
    );
    if (users.length > 0) {
      warn(`kept ${image}: used by ${users.join(", ")}`);
      continue;
    }
    if (docker(["image", "rm", image]).ok) {
      ok(`image ${image}`);
    } else {
      warn(`couldn't remove ${image}`);
    }
  }
}

await runMain(import.meta, cleanDocker);
