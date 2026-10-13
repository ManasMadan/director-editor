/**
 * Makes this repository a new project: rewrites the template's identity (the GitHub
 * owner and repository, the image registry, the product name, the mobile bundle id and
 * URL scheme, and the `boilerplate` name in compose, kind, Kubernetes labels and
 * resources, cookies and test addresses) in every tracked text file, then fails if any
 * old identifier is left.
 *
 *   bun run rename <name> --owner <github owner> [--product "<Product>"] [--bundle-id <id>]
 *
 * `name` is lowercase letters, digits and dashes (it names Kubernetes resources and the
 * compose project). The product defaults to the name capitalised, the bundle id to
 * `com.<name without dashes>.app`. Run it once, on a clean tree, then review the diff.
 * The default branch (`master`) stays: rename it in GitHub's settings and the
 * workflows together if you want another.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fail, messageOf, ok, ROOT, type Run, runMain, runSync } from "./lib";

export interface Identity {
  name: string;
  owner: string;
  product: string;
  bundleId: string;
}

/**
 * Left as they are: this script and its test (which name the identity on purpose; the
 * script's `OLD` is rewritten on its own), and requests captured from other software,
 * whose bytes it signed (Stalwart's webhooks, sent from the template's mail domain).
 */
const KEPT = new Set([
  "scripts/rename.ts",
  "scripts/rename.test.ts",
  "apps/webhooks/src/inbound/stalwart-events.test.ts",
]);

/**
 * What the project is called now, as `rename` finds it. Renaming rewrites this too, so a
 * renamed project can be renamed again.
 */
export const OLD: Identity = {
  name: "boilerplate",
  owner: "ManasMadan",
  product: "Boilerplate",
  bundleId: "com.boilerplate.app",
};

/**
 * The replacements, most specific first: each later one would mangle an earlier match.
 * Plain text, not patterns: nothing here is a URL check, only a rewrite of what's written.
 */
export function replacements({ name, owner, product, bundleId }: Identity): [string, string][] {
  return [
    [`${OLD.owner}/${OLD.name}`, `${owner}/${name}`],
    [`ghcr.io/${OLD.owner.toLowerCase()}/${OLD.name}`, `ghcr.io/${owner.toLowerCase()}/${name}`],
    [OLD.owner, owner],
    [OLD.owner.toLowerCase(), owner.toLowerCase()],
    // The app store identifiers (with their .development / .preview variants), and the
    // push tests' APNs topic.
    [OLD.bundleId, bundleId],
    [`dev.${OLD.name}.app`, bundleId],
    [OLD.product, product],
    [OLD.name, name],
  ];
}

export function rewrite(text: string, identity: Identity) {
  // One pass, so a replacement never rewrites what another wrote (a lowercase owner
  // would turn the registry's lowercase path back into the owner's spelling). The first
  // pair for a text wins, as alternatives in the pattern do.
  const pairs = replacements(identity);
  const to = new Map<string, string>();
  for (const [from, into] of pairs) {
    if (!to.has(from)) {
      to.set(from, into);
    }
  }
  const pattern = new RegExp(
    pairs.map(([from]) => from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "g",
  );
  // A function replacement: a string one would read `$&` or `$$` in the product as patterns.
  return text.replace(pattern, (match) => to.get(match) ?? match);
}

/** The identity from the command line, with its defaults; throws on a bad value. */
export function identityFrom(argv: string[]): Identity {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      owner: { type: "string" },
      product: { type: "string" },
      "bundle-id": { type: "string" },
    },
  });
  const [name] = positionals;
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(
      "The name must be lowercase letters, digits and dashes, starting with a letter.",
    );
  }
  if (!values.owner || !/^[A-Za-z0-9-]+$/.test(values.owner)) {
    throw new Error("--owner must be the GitHub user or organization that owns the repository.");
  }
  if (name === OLD.name) {
    throw new Error(`The project is already called ${OLD.name}.`);
  }
  const bundleId = values["bundle-id"] ?? `com.${name.replaceAll("-", "")}.app`;
  if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(bundleId)) {
    throw new Error("--bundle-id must be reverse DNS, like com.example.app.");
  }
  const product = values.product ?? name.charAt(0).toUpperCase() + name.slice(1);
  return { name, owner: values.owner, product, bundleId };
}

/**
 * Old identifiers still in `files` (path: line), after a rename to `identity`. One the
 * new identity also holds (the same owner, renaming only the project) isn't a leftover.
 */
export function leftovers(files: Map<string, string>, identity?: Identity) {
  const kept = Object.values(identity ?? {})
    .join(" ")
    .toLowerCase();
  const ids = [OLD.name, OLD.owner].filter((id) => !kept.includes(id.toLowerCase()));
  if (ids.length === 0) {
    return [];
  }
  const old = new RegExp(ids.join("|"), "i");
  return [...files].flatMap(([path, text]) =>
    text
      .split("\n")
      .flatMap((line, index) => (old.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : [])),
  );
}

/** Rewrites every tracked text file under `root`; returns the paths it changed. */
export function rename(root: string, identity: Identity) {
  const tracked = runSync("git", ["ls-files", "-z"], { cwd: root })
    .stdout.split("\0")
    .filter(Boolean);
  const files = new Map<string, string>();
  const changed: string[] = [];
  for (const path of tracked.filter((path) => !KEPT.has(path))) {
    const bytes = readFileSync(join(root, path));
    if (bytes.includes(0)) {
      continue; // binary
    }
    const before = bytes.toString("utf8");
    const after = rewrite(before, identity);
    files.set(path, after);
    if (after !== before) {
      writeFileSync(join(root, path), after);
      changed.push(path);
    }
  }
  const self = join(root, "scripts/rename.ts");
  if (tracked.includes("scripts/rename.ts")) {
    const keys: (keyof Identity)[] = ["name", "owner", "product", "bundleId"];
    const lines = keys.map((key) => `  ${key}: ${JSON.stringify(identity[key])},`);
    const text = readFileSync(self, "utf8").replace(
      /export const OLD: Identity = \{[^}]*\};/,
      `export const OLD: Identity = {\n${lines.join("\n")}\n};`,
    );
    writeFileSync(self, text);
    changed.push("scripts/rename.ts");
  }
  return { changed, left: leftovers(files, identity) };
}

/** The command: renames the checkout at `root`; the exit code. */
export function main(argv = process.argv.slice(2), root = ROOT, run: Run = runSync): number {
  let identity: Identity;
  try {
    identity = identityFrom(argv);
  } catch (error) {
    fail(messageOf(error));
    return 1;
  }
  const { changed, left } = rename(root, identity);
  ok(`${changed.length} files rewritten for ${identity.owner}/${identity.name}`);
  // A longer or shorter name moves where lines wrap: format what changed, as lint expects.
  run(
    "bunx",
    [
      "biome",
      "format",
      "--write",
      "--files-ignore-unknown=true",
      "--no-errors-on-unmatched",
      ...changed,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (left.length > 0) {
    for (const line of left) {
      console.error(`  ${line}`);
    }
    fail(`${left.length} lines still name the template; change them by hand.`);
    return 1;
  }
  ok(
    "No old identifier left. Run `bun install` (the lockfile's root name changed), then review the diff.",
  );
  return 0;
}

await runMain(import.meta, main);
