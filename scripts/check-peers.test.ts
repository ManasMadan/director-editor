import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./lib";
import { captureOutput } from "./stand-ins";

// Plain JavaScript, copied into the images on its own: imported by path, untyped.
const { main, missingPeers } = await import(join(ROOT, "deploy/docker/check-peers.mjs"));

afterEach(() => mock.restore());

/** A node_modules tree under a fresh directory: package path → its package.json. */
function installed(packages: Record<string, object>) {
  const root = mkdtempSync(join(tmpdir(), "peers-"));
  for (const [path, manifest] of Object.entries(packages)) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "package.json"), JSON.stringify(manifest));
  }
  return root;
}

describe("the images' peer dependency check", () => {
  it("finds a required peer nothing installed, anywhere in the tree", () => {
    const root = installed({
      "node_modules/react": { name: "react" },
      "node_modules/ui": { name: "ui", peerDependencies: { react: "*" } },
      "node_modules/@scope/kit": { name: "@scope/kit", peerDependencies: { "peers-gone": "*" } },
      "node_modules/ui/node_modules/inner": {
        name: "inner",
        peerDependencies: { react: "*", "peers-also-gone": "*" },
      },
      "node_modules/charts": {
        name: "charts",
        peerDependencies: { "peers-optional": "*" },
        peerDependenciesMeta: { "peers-optional": { optional: true } },
      },
    });
    // Not packages: a dot folder and a folder without a manifest.
    mkdirSync(join(root, "node_modules/.bin"));
    mkdirSync(join(root, "node_modules/empty"));
    expect(missingPeers(root)).toEqual({
      packages: 5,
      missing: ["@scope/kit needs peers-gone", "inner needs peers-also-gone"],
    });
  });

  it("fails naming each missing peer, and passes when there's none", () => {
    const printed = captureOutput();
    const broken = installed({
      "node_modules/ui": { name: "ui", peerDependencies: { "peers-x": "*" } },
    });
    expect(main(broken)).toBe(1);
    expect(printed()).toContain("  ui needs peers-x");
    expect(main(mkdtempSync(join(tmpdir(), "peers-")))).toBe(0);
    expect(printed()).toContain("Peer dependencies OK (0 packages).");
  });
});
