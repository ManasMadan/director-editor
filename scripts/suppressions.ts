/**
 * Suppressions, skipped tests and coverage pragmas: each one hides a problem instead of
 * fixing it, so one is refused unless a row of docs/testing.md's tables allows it, for
 * that file and that kind, with the reason. A skipped test needs a row under "Skipped
 * tests", a coverage pragma one under "Coverage exceptions", a type-coverage ignore one
 * under "Type-coverage exceptions", and anything else (a lint or type suppression, a
 * linter's rule turned off in its configuration) one under "Suppressions" that names it.
 * A focused test is never allowed. The Claude Code hook (.claude/hooks/suppressions.ts)
 * applies this to every edit, and `bun scripts/suppressions.ts` (in `bun run lint`, so in
 * CI, and in the Stop hook, which catches what a shell command wrote) to every file.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runMain } from "./lib";

/** The tables of docs/testing.md that allow a suppression. */
export const EXCEPTION_SECTIONS = [
  "## Coverage exceptions",
  "## Skipped tests",
  "## Suppressions",
  "## Type-coverage exceptions",
] as const;
type Section = (typeof EXCEPTION_SECTIONS)[number];
const [UNCOVERED, SKIPPED, SUPPRESSED, UNTYPED] = EXCEPTION_SECTIONS;

/** A test that doesn't always run, or runs expecting to fail. */
const SKIPPED_TEST = new RegExp(
  [
    /\b(it|test|describe|suite|bench)\.(skip|skipIf|runIf|todo|fixme|fails?)\s*\(/,
    /\b(ctx|context)\.skip\s*\(/,
    /\bx(it|describe|test)\s*\(/,
    /\bpytest\.(skip|xfail)\s*\(/,
    /@pytest\.mark\.(skip|skipif|xfail)\b/,
  ]
    .map((pattern) => pattern.source)
    .join("|"),
  "g",
);

/** What counts in any file the check reads, by name, and the table that may allow it. */
export const SUPPRESSIONS: Record<string, { pattern: RegExp; table?: Section }> = {
  "@ts-ignore": { pattern: /@ts-ignore/g, table: SUPPRESSED },
  "@ts-expect-error": { pattern: /@ts-expect-error/g, table: SUPPRESSED },
  "@ts-nocheck": { pattern: /@ts-nocheck/g, table: SUPPRESSED },
  "biome-ignore": { pattern: /biome-ignore/g, table: SUPPRESSED },
  "eslint-disable": { pattern: /eslint-disable/g, table: SUPPRESSED },
  "coverage ignore (v8, c8, istanbul)": {
    pattern: /\/\*\s*(v8|c8|istanbul)\s+ignore/g,
    table: UNCOVERED,
  },
  "# pragma: no cover": { pattern: /#\s*pragma:\s*no cover/g, table: UNCOVERED },
  "# type: ignore": { pattern: /#\s*type:\s*ignore/g, table: SUPPRESSED },
  "# pyright: ignore": { pattern: /#\s*pyright:\s*ignore/g, table: SUPPRESSED },
  "# noqa": { pattern: /#\s*noqa\b/g, table: SUPPRESSED },
  "type-coverage:ignore": { pattern: /type-coverage:ignore/g, table: UNTYPED },
  // Python's unchecked cast: parse it (Pydantic) or narrow it (isinstance) instead.
  "typing.cast()": { pattern: /\bcast\(/g, table: SUPPRESSED },
  "-- squawk-ignore": { pattern: /--\s*squawk-ignore/g, table: SUPPRESSED },
  "# shellcheck disable": { pattern: /#\s*shellcheck\s+disable/g, table: SUPPRESSED },
  "# hadolint ignore": { pattern: /#\s*hadolint\s+ignore/g, table: SUPPRESSED },
  "# zizmor: ignore": { pattern: /#\s*zizmor:\s*ignore/g, table: SUPPRESSED },
  "# tflint-ignore": { pattern: /#\s*tflint-ignore/g, table: SUPPRESSED },
  "a skipped test (.skip, .skipIf, .runIf, .todo, .fixme, .fail, xit, pytest's skip and xfail)": {
    pattern: SKIPPED_TEST,
    table: SKIPPED,
  },
  "a focused test (.only, fit)": {
    pattern: /\b(it|test|describe|suite)\.only\s*\(|\bf(it|describe)\s*\(/g,
  },
};

/**
 * Rules a linter's configuration turns off, by the file it's in: each match's first group
 * names the rule, and the kind is "<rule> off in <file>". Biome counts a rule (or a group)
 * set down to a warning too, since a warning fails no check.
 */
export const RULES_OFF: [file: RegExp, rule: RegExp][] = [
  [/^biome\.jsonc$/, /"(\w+)":\s*(?:\{\s*"level":\s*)?"(?:off|warn|info)"/g],
  [/(^|\/)zizmor\.ya?ml$/, /^ {2}([\w-]+):\n(?: {4}.*\n)*? {4}(?:disable: true|ignore:)/gm],
  [/(^|\/)\.shellcheckrc$/, /^disable=(\S+)/gm],
  [/(^|\/)\.tflint\.hcl$/, /^rule "(\w+)"\s*\{[^}]*enabled\s*=\s*false/gm],
];

/** Files that name the patterns as data: this module, its test and the hook's. */
export const DEFINES_THEM = new Set([
  "scripts/suppressions.ts",
  "scripts/suppressions.test.ts",
  ".claude/hooks/suppressions.test.ts",
]);

/**
 * The files the rules apply to: source, migrations, shell scripts and git hooks,
 * Dockerfiles, workflows and other YAML, OpenTofu, and the linters' configurations.
 */
export const CODE =
  /\.(ts|tsx|js|mjs|cjs|py|sql|sh|bash|ya?ml|tf|hcl)$|(^|\/)[^/]*Dockerfile$|^\.husky\/[^/]+$|^biome\.jsonc$|(^|\/)\.shellcheckrc$/;

/** One kind found in a file: how many, the table that may allow it, and what a row names. */
type Found = { count: number; table?: Section; names: string };

/** A linter's configuration holds only rules (its comments may name a suppression); code, the rest. */
function found(text: string, path: string): Map<string, Found> {
  const kinds = new Map<string, Found>();
  const config = RULES_OFF.filter(([file]) => file.test(path));
  for (const [name, { pattern, table }] of config.length ? [] : Object.entries(SUPPRESSIONS)) {
    const count = text.match(pattern)?.length ?? 0;
    if (count) {
      kinds.set(name, { count, table, names: name });
    }
  }
  for (const [, rule] of config) {
    for (const [, name = ""] of text.matchAll(rule)) {
      const kind = `${name} off in ${path}`;
      const count = (kinds.get(kind)?.count ?? 0) + 1;
      kinds.set(kind, { count, table: SUPPRESSED, names: name });
    }
  }
  return kinds;
}

/** How many of each kind `text` (the file at `path`) has. */
export function countSuppressions(text: string, path = ""): Map<string, number> {
  return new Map([...found(text, path)].map(([name, { count }]) => [name, count]));
}

/** The kinds `after` has more of than `before`. */
export function addedSuppressions(before: string, after: string, path = ""): string[] {
  const was = countSuppressions(before, path);
  return [...countSuppressions(after, path)]
    .filter(([name, count]) => count > (was.get(name) ?? 0))
    .map(([name]) => name);
}

/** A row of one of docs/testing.md's exceptions tables. */
export type Row = { section: Section; files: string[]; text: string };

/**
 * The rows of the exceptions tables in docs/testing.md (under one of EXCEPTION_SECTIONS;
 * other tables in the file allow nothing), each with the files it names (backticked).
 */
export function exceptionRows(root: string): Row[] {
  const doc = join(root, "docs/testing.md");
  if (!existsSync(doc)) {
    return [];
  }
  let section: Section | undefined;
  const rows: Row[] = [];
  for (const line of readFileSync(doc, "utf8").split("\n")) {
    if (line.startsWith("## ")) {
      section = EXCEPTION_SECTIONS.find((name) => name === line.trim());
    } else if (section && line.startsWith("|")) {
      const files = [...line.matchAll(/`(?<path>[^`\s]+?)(?::\d+)?`/g)]
        .flatMap((m) => m.groups?.path ?? [])
        .filter((path) => /[./]/.test(path));
      rows.push({ section, files, text: line });
    }
  }
  return rows;
}

/** The files the Coverage exceptions table lists: the only ones allowed below 100%. */
export const coverageExceptions = (root: string) =>
  new Set(
    exceptionRows(root)
      .filter((row) => row.section === UNCOVERED)
      .flatMap((row) => row.files),
  );

/**
 * The kinds in `text` (the file at `path`) that no row allows: one in the kind's table
 * naming the file, and, in the Suppressions table, naming the kind (`# noqa: E501` names
 * `# noqa`; a rule turned off is named by the rule).
 */
export function unallowed(rows: Row[], path: string, text: string): string[] {
  return [...found(text, path)]
    .filter(
      ([, { table, names }]) =>
        !rows.some(
          (row) =>
            row.section === table &&
            row.files.includes(path) &&
            (table !== SUPPRESSED || row.text.includes(names)),
        ),
    )
    .map(([name]) => name);
}

/** Tracked files with a suppression that no row allows. */
export function unlisted(root: string, files: string[]): { path: string; kinds: string[] }[] {
  const rows = exceptionRows(root);
  return files
    .filter((path) => CODE.test(path) && !DEFINES_THEM.has(path) && !/\/generated\//.test(path))
    .map((path) => ({
      path,
      kinds: unallowed(rows, path, readFileSync(join(root, path), "utf8")),
    }))
    .filter(({ kinds }) => kinds.length > 0);
}

/**
 * Reports every file under `root` git tracks or would (new files too, so a suppression
 * written by a shell command is caught before `git add`) with a suppression no row
 * allows; the exit code.
 */
export function checkSuppressions(root = join(import.meta.dir, "..")): number {
  const files = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
  })
    .stdout.toString()
    .split("\n")
    .filter((path) => path && existsSync(join(root, path)));
  const found = unlisted(root, files);
  for (const { path, kinds } of found) {
    console.error(`  \x1b[31m✖\x1b[0m ${path}: ${kinds.join(", ")}`);
  }
  if (found.length === 0) {
    return 0;
  }
  console.error(
    "\nFix the cause, or add a row for the file with the reason to docs/testing.md: Skipped tests, Coverage exceptions, Type-coverage exceptions, or Suppressions naming what it suppresses. A focused test is never allowed.",
  );
  return 1;
}

await runMain(import.meta, checkSuppressions);
