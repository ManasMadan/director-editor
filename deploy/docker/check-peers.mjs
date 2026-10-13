// Fails when an installed package's required peer dependency isn't installed. The repo
// installs peers only where they're declared (bunfig: peer = false), so a runtime
// dependency whose peer nobody declares would crash the service on first import. This
// runs on each image's production dependencies, before anything ships.
//
//   node check-peers.mjs <dir containing node_modules>
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function* packages(dir) {
  if (!existsSync(dir)) {
    return;
  }
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) {
      continue;
    }
    const path = join(dir, name);
    if (name.startsWith("@")) {
      for (const scoped of readdirSync(path)) {
        yield join(path, scoped);
      }
    } else {
      yield path;
    }
  }
}

/** Node's lookup: node_modules/<name> in the package's directory and every parent. */
function resolvable(from, name) {
  let dir = from;
  while (!existsSync(join(dir, "node_modules", name, "package.json"))) {
    if (dirname(dir) === dir) {
      return false;
    }
    dir = dirname(dir);
  }
  return true;
}

/** The required peers of the package in `dir` that it can't import. */
function unresolved(dir) {
  const {
    name,
    peerDependencies = {},
    peerDependenciesMeta = {},
  } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return Object.keys(peerDependencies)
    .filter((peer) => !peerDependenciesMeta[peer]?.optional && !resolvable(dir, peer))
    .map((peer) => `${name} needs ${peer}`);
}

/** The packages installed under `root`, and each required peer none of them can import. */
export function missingPeers(root) {
  const missing = [];
  const seen = new Set();
  const queue = [join(root, "node_modules")];
  while (queue.length > 0) {
    for (const dir of packages(queue.pop())) {
      if (seen.has(dir) || !existsSync(join(dir, "package.json"))) {
        continue;
      }
      seen.add(dir);
      queue.push(join(dir, "node_modules"));
      missing.push(...unresolved(dir));
    }
  }
  return { packages: seen.size, missing: [...new Set(missing)].sort() };
}

/** The check on `root`; the exit code. */
export function main(root = process.argv[2] ?? ".") {
  const { packages, missing } = missingPeers(root);
  if (missing.length > 0) {
    console.error("Missing peer dependencies (declare them where the package is used):");
    for (const line of missing) {
      console.error(`  ${line}`);
    }
    return 1;
  }
  console.log(`Peer dependencies OK (${packages} packages).`);
  return 0;
}

// Run as a script, not when a test imports it.
import.meta.main && process.exit(main());
