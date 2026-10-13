/**
 * Every image the Dockerfiles build from is pinned by digest as well as tag, so a tag
 * moved upstream can't change what an image is built from until Renovate proposes it.
 * And each build only needs what its pruned tree has.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { imageReferences } from "./image-scan";
import { ROOT, runSync } from "./lib";

const DIR = join(import.meta.dir, "../deploy/docker");
const DIGEST = /@sha256:[0-9a-f]{64}$/;

/** The image references a Dockerfile names itself: its frontend, ARG defaults, FROMs. */
function references(text: string): string[] {
  const stages = [...text.matchAll(/^FROM .+ AS (\S+)$/gim)].map((m) => m[1]);
  return [
    ...[...text.matchAll(/^# syntax=(\S+)$/gm)].map((m) => m[1] as string),
    ...[...text.matchAll(/^ARG \w+_IMAGE=(\S+)$/gm)].map((m) => m[1] as string),
    ...[...text.matchAll(/^FROM (\S+)/gm)]
      .map((m) => m[1] as string)
      .filter((image) => !image.startsWith("${") && !stages.includes(image)),
  ];
}

describe("the Dockerfiles", () => {
  const files = readdirSync(DIR).filter((file) => file.endsWith(".Dockerfile"));

  it.each(files)("%s pins every image by digest", (file) => {
    const refs = references(readFileSync(join(DIR, file), "utf8"));
    expect(refs.length).toBeGreaterThan(1);
    for (const ref of refs) {
      expect({ ref, pinned: DIGEST.test(ref) }).toEqual({ ref, pinned: true });
    }
  });
});

describe("the dev container's Dockerfile", () => {
  it("pins every image by digest", () => {
    const refs = references(readFileSync(join(ROOT, ".devcontainer/Dockerfile"), "utf8"));
    expect(refs.length).toBeGreaterThan(1);
    expect(refs.filter((ref) => !DIGEST.test(ref))).toEqual([]);
  });
});

describe("the images the manifests and compose run", () => {
  // Every image reference in deploy/ (the charts' values, the local and Argo CD manifests)
  // and the compose files, as Renovate's deploy manager and Compose's read them: by tag
  // and digest, so a moved tag changes nothing until Renovate proposes it. The images we
  // build locally (<name>:dev) are the one exception: they have no digest to pin.
  it("pins each by digest", () => {
    const refs = imageReferences();
    expect(refs.length).toBeGreaterThan(10);
    const loose = refs.filter((ref) => !DIGEST.test(ref) && !/:dev$/.test(ref));
    expect(loose).toEqual([]);
  });
});

describe("the Node service images' health check", () => {
  // The image's PORT is the one the health check calls when nothing else sets it, so it
  // must be the port the service listens on by default.
  it("calls each service on the port its env.ts defaults to", () => {
    const bake = readFileSync(join(ROOT, "docker-bake.hcl"), "utf8");
    const map = /PORT\s*=\s*\{([^}]*)\}\[service\]/.exec(bake)?.[1] ?? "";
    const baked = Object.fromEntries(
      [...map.matchAll(/(\w+)\s*=\s*"(\d+)"/g)].map((m) => [m[1], m[2]]),
    );
    const services = /service\s*=\s*\[([^\]]*)\]/.exec(bake)?.[1]?.match(/\w+/g) ?? [];
    const defaults = Object.fromEntries(
      services.map((service) => [
        service,
        /PORT: port\((\d+)\)/.exec(
          readFileSync(join(ROOT, `apps/${service}/src/env.ts`), "utf8"),
        )?.[1],
      ]),
    );
    expect(services.length).toBeGreaterThan(0);
    expect(baked).toEqual(defaults);
  });
});

describe("the web image's build", () => {
  // `next build` type-checks the project next.config.ts's tsconfigPath names, in a tree
  // pruned to the web app and its workspace dependencies, where no code generator has run
  // (web.Dockerfile builds with --only): only their committed files are there.
  it("type-checks only committed files of the app and the packages it depends on", () => {
    const web = join(ROOT, "apps/web");
    const config = readFileSync(join(web, "next.config.ts"), "utf8");
    const tsconfig = /tsconfigPath: "([^"]+)"/.exec(config)?.[1] ?? "tsconfig.json";
    const { dependencies, devDependencies } = JSON.parse(
      readFileSync(join(web, "package.json"), "utf8"),
    ) as Record<string, Record<string, string>>;
    const pruned = [
      "apps/web/",
      ...Object.keys({ ...dependencies, ...devDependencies })
        .filter((name) => name.startsWith("@repo/"))
        .map((name) => `packages/${name.slice("@repo/".length)}/`),
    ];
    const committed = new Set(runSync("git", ["ls-files"], { cwd: ROOT }).stdout.split("\n"));
    const listed = runSync("bunx", ["tsc", "--listFilesOnly", "-p", tsconfig], { cwd: web });
    expect(listed.status).toBe(0);
    const missing = listed.stdout
      .split("\n")
      .filter((file) => file && !file.includes("/node_modules/"))
      .map((file) => relative(ROOT, file))
      // Next writes these itself, as the build starts.
      .filter((file) => !/^apps\/web\/(\.next\/|next-env\.d\.ts$)/.test(file))
      .filter((file) => !(committed.has(file) && pruned.some((dir) => file.startsWith(dir))));
    expect(missing).toEqual([]);
    // A whole type-check program: seconds alone, longer beside the other suites a push runs.
  }, 30_000);
});
