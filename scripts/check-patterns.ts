/**
 * Code shapes the coding standards rule out and Biome has no rule for, found in the
 * TypeScript syntax tree of every tracked source file: `bun run lint:patterns` (part of
 * `bun run lint`, so CI's lint job).
 *
 * In the services' and packages' source (src/), the repo's scripts, the load test and the
 * code generators (tests left out):
 *   - a cast of parsed JSON (`JSON.parse(text) as T`, `(await response.json()) as T`):
 *     parse it with a schema;
 *   - a type argument on raw SQL (`$queryRaw<T>`): it asserts the columns, parse them
 *     with `rows`/`row` (packages/nest-common/src/sql.ts);
 *   - an optional chain three deep or more (`a?.b?.c?.d`): data that deep is required,
 *     so parse it instead of guarding every step;
 *   - a role compared with "member": access goes to the roles named (owner, admin), never
 *     to everyone who isn't a member (packages/contracts/src/roles.ts);
 *   - an error answered by hand (`reply.status(n).send({ code })`): `sendError` gives it
 *     the contract's shape.
 * In tests: a fixed sleep (`new Promise((resolve) => setTimeout(resolve, n))`, not in a
 * loop that polls for something): wait for the condition instead (`eventually`,
 * `vi.waitFor`, `expect.poll`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { fail, ok, ROOT, runMain } from "./lib";

/**
 * Where the rules for source apply: the services' and packages' source, and the repo's
 * own scripts, load test and code generators.
 */
const SOURCE = /^((apps|packages)\/[^/]+\/src\/.+|(scripts|load|turbo\/generators)\/[^/]+)\.tsx?$/;
const TEST = /\.(test|spec)\.tsx?$|(^|\/)(test|e2e)\//;
const GENERATED = /\/generated\/|\.gen\.ts$|\.d\.ts$/;
/** The one place an error reply is built by hand. */
const ERROR_HELPER = "packages/nest-common/src/http-errors.ts";

type Finding = { line: number; problem: string };

/** The expression under any parentheses and `await`s. */
function unwrap(node: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) {
    return unwrap(node.expression);
  }
  return node;
}

/** `JSON.parse(...)` or `<anything>.json()`. */
function isParsedJson(node: ts.Expression) {
  const call = unwrap(node);
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) {
    return false;
  }
  const { expression, name } = call.expression;
  if (name.text === "json") {
    return call.arguments.length === 0;
  }
  return name.text === "parse" && ts.isIdentifier(expression) && expression.text === "JSON";
}

/** How many `?.` a member or call chain has, down from this node. */
function optionalDepth(node: ts.Node): number {
  if (
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node) &&
    !ts.isCallExpression(node) &&
    !ts.isNonNullExpression(node)
  ) {
    return 0;
  }
  const own = "questionDotToken" in node && node.questionDotToken ? 1 : 0;
  return own + optionalDepth(node.expression);
}

/** Whether `node` continues a chain its parent is part of (only the top is counted). */
function continuesChain(node: ts.Node) {
  const { parent } = node;
  return (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent) ||
      ts.isCallExpression(parent) ||
      ts.isNonNullExpression(parent)) &&
    parent.expression === node
  );
}

/** `role` or `x.role`, the thing an access check compares. */
function namesRole(node: ts.Expression) {
  const name = ts.isPropertyAccessExpression(node) ? node.name.text : node.getText();
  return /role$/i.test(name);
}

/** A role compared with "member", either way round. */
function comparesMemberRole(node: ts.BinaryExpression) {
  const kind = node.operatorToken.kind;
  const equality =
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if (!equality) {
    return false;
  }
  const member = (side: ts.Expression) => ts.isStringLiteral(side) && side.text === "member";
  return (
    (member(node.right) && namesRole(node.left)) || (member(node.left) && namesRole(node.right))
  );
}

/** `reply.status(n).send({ code ... })` or `.code(n).send(...)`. */
function sendsErrorByHand(node: ts.CallExpression) {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "send") {
    return false;
  }
  const status = callee.expression;
  const [body] = node.arguments;
  return (
    ts.isCallExpression(status) &&
    ts.isPropertyAccessExpression(status.expression) &&
    ["status", "code"].includes(status.expression.name.text) &&
    body !== undefined &&
    ts.isObjectLiteralExpression(body) &&
    body.properties.some((property) => property.name?.getText() === "code")
  );
}

/** Whether a loop in the same function encloses `node`: a poll, which waits for something. */
function inLoop(node: ts.Node): boolean {
  for (let scope = node.parent; scope && !ts.isFunctionLike(scope); scope = scope.parent) {
    if (ts.isIterationStatement(scope, false)) {
      return true;
    }
  }
  return false;
}

/**
 * `new Promise((resolve) => setTimeout(resolve, n))` outside a polling loop: a sleep for
 * a guessed time.
 */
function sleeps(node: ts.CallExpression) {
  const [first] = node.arguments;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "setTimeout") {
    return false;
  }
  if (!first || !ts.isIdentifier(first)) {
    return false;
  }
  let executor = node.parent;
  while (executor && !ts.isFunctionLike(executor)) {
    executor = executor.parent;
  }
  if (!executor || (!ts.isArrowFunction(executor) && !ts.isFunctionExpression(executor))) {
    return false;
  }
  const promise = executor.parent;
  return (
    ts.isNewExpression(promise) &&
    promise.expression.getText() === "Promise" &&
    executor.parameters[0]?.name.getText() === first.text &&
    !inLoop(promise)
  );
}

/** What a source file breaks, for the rules that apply to its path. */
export function findPatterns(path: string, text: string): Finding[] {
  const source = SOURCE.test(path) && !TEST.test(path) && !GENERATED.test(path);
  const test = TEST.test(path);
  if (!source && !test) {
    return [];
  }
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found: Finding[] = [];
  const report = (node: ts.Node, problem: string) =>
    found.push({ line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, problem });

  const visit = (node: ts.Node) => {
    if (source) {
      checkSource(node, path, report);
    }
    if (test && ts.isCallExpression(node) && sleeps(node)) {
      report(node, "a fixed sleep: wait for the condition (eventually, vi.waitFor, expect.poll)");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The rules for source files, on one node. */
function checkSource(
  node: ts.Node,
  path: string,
  report: (node: ts.Node, problem: string) => void,
) {
  if (ts.isAsExpression(node) && isParsedJson(node.expression)) {
    report(node, "parsed JSON cast to a type: parse it with a schema");
  }
  if (
    (ts.isTaggedTemplateExpression(node) || ts.isCallExpression(node)) &&
    node.typeArguments?.length &&
    /\$queryRaw(Unsafe)?$/.test(
      ts.isTaggedTemplateExpression(node) ? node.tag.getText() : node.expression.getText(),
    )
  ) {
    report(node, "raw SQL with a type argument: parse the rows (rows/row in nest-common)");
  }
  if (optionalDepth(node) >= 3 && !continuesChain(node)) {
    report(node, "an optional chain three deep: parse the data instead of guarding each step");
  }
  if (ts.isBinaryExpression(node) && comparesMemberRole(node)) {
    report(node, 'a role compared with "member": allow the roles named (owner, admin)');
  }
  if (ts.isCallExpression(node) && path !== ERROR_HELPER && sendsErrorByHand(node)) {
    report(node, "an error sent by hand: use sendError (packages/nest-common)");
  }
}

/** Reports every finding in the files git tracks under `root`; the exit code. */
export function checkPatterns(root = ROOT): number {
  const tracked = Bun.spawnSync(["git", "ls-files", "*.ts", "*.tsx"], { cwd: root })
    .stdout.toString()
    .split("\n")
    .filter(Boolean);
  const found = tracked.flatMap((path) =>
    findPatterns(path, readFileSync(join(root, path), "utf8")).map(
      ({ line, problem }) => `${path}:${line}: ${problem}`,
    ),
  );
  for (const line of found) {
    fail(line);
  }
  if (found.length === 0) {
    ok("no ruled-out code patterns");
  }
  return found.length === 0 ? 0 : 1;
}

await runMain(import.meta, checkPatterns);
