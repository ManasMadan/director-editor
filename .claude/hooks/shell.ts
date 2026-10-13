/**
 * What a shell command line does that the guard rails care about: which files it writes
 * (so the file rules apply to Bash too, not only to Edit and Write) and whether it skips
 * a check, reaches outside the machine or destroys something. Pure and tested
 * (shell.test.ts); bash-guard.ts applies it.
 *
 * It reads ordinary commands (redirects, tee, sed -i, cp, mv, rm, ...). Writes from inside
 * an interpreter (`python -c "open(...)"`) can't be read from the command line, and
 * nothing else stops them: settings.json's deny rules cover Claude's own Read and Edit
 * tools only. That's why settings.json allows only named scripts, not `bun run *`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Verdict } from "./file-rules";
import { ROOT } from "./lib";

/** Whether `bin` is installed in the workspace (node_modules/.bin). */
const installedBin = (bin: string) => existsSync(join(ROOT, "node_modules/.bin", bin));

/** One simple command: its words, after leading `VAR=value` assignments. */
interface Simple {
  env: Record<string, string>;
  words: string[];
  /** Files its redirects write (`>`, `>>`, `&>`, `2>`). */
  redirects: string[];
}

const OPERATORS = new Set([";", "&&", "||", "|", "&", "\n", "(", ")"]);

/** Reads a command line into words and operators, one character (or a run) at a time. */
class Lexer {
  readonly tokens: string[] = [];
  private word = "";
  private inWord = false;
  /** Where it's read to: each step reads from here and moves it past what it read. */
  private i = 0;

  constructor(private readonly line: string) {}

  /** Words and operators, with quotes and backslashes resolved. */
  read(): string[] {
    for (; this.i < this.line.length; this.i++) {
      if (!this.step(this.line[this.i] as string, this.line[this.i + 1])) {
        break;
      }
    }
    this.flush();
    return this.tokens;
  }

  /** Reads one character (and what it starts); false to stop reading the line. */
  private step(char: string, next: string | undefined): boolean {
    if (char === "'" || char === '"') {
      this.quote(char);
    } else if (char === "\\" && next !== undefined) {
      this.append(next, 1);
    } else if (char === " " || char === "\t") {
      this.flush();
    } else {
      return this.operatorStep(char, next);
    }
    return true;
  }

  /** Reads an operator or redirect, or else one more character of the word. */
  private operatorStep(char: string, next: string | undefined): boolean {
    if ((char === "&" || char === "|") && next === char) {
      this.operator(char + next, 1);
    } else if (char === ">" || (char === "&" && next === ">")) {
      this.redirect(char);
    } else if (char === "<" && next === "<") {
      return this.heredoc();
    }
    // Input: its file is read, not written.
    else if (char === "<" || OPERATORS.has(char)) {
      this.operator(char, 0);
    } else {
      this.append(char, 0);
    }
    return true;
  }

  private flush() {
    if (this.inWord) {
      this.tokens.push(this.word);
    }
    this.word = "";
    this.inWord = false;
  }

  private append(text: string, skip: number) {
    this.word += text;
    this.inWord = true;
    this.i += skip;
  }

  private operator(token: string, skip: number) {
    this.flush();
    this.tokens.push(token);
    this.i += skip;
  }

  private quote(char: string) {
    const end = this.line.indexOf(char, this.i + 1);
    const stop = end === -1 ? this.line.length : end;
    this.append(this.line.slice(this.i + 1, stop), 0);
    this.i = stop;
  }

  private redirect(char: string) {
    const { line } = this;
    // `2>` and `&>` redirect too: the descriptor digit belongs to the operator.
    const descriptor = /^\d$/.test(this.word) ? this.word : "";
    if (descriptor) {
      this.word = "";
    }
    this.flush();
    const append = line[this.i + (char === "&" ? 2 : 1)] === ">";
    this.tokens.push(`${descriptor}${char === "&" ? "&>" : ">"}${append ? ">" : ""}`);
    this.i += (char === "&" ? 1 : 0) + (append ? 1 : 0);
    // `>&2` duplicates a descriptor; it writes no file.
    if (line[this.i + 1] === "&") {
      this.tokens.pop();
      this.i++;
      while (/\d/.test(line[this.i + 1] ?? "")) {
        this.i++;
      }
    }
  }

  /** A heredoc: the body is data, not commands. Skips to its closing marker. */
  private heredoc(): boolean {
    const { line } = this;
    this.flush();
    const rest = line.slice(this.i + 2).replace(/^[-~]?\s*/, "");
    const marker = /^['"]?(\w+)['"]?/.exec(rest)?.[1];
    const bodyStart = line.indexOf("\n", this.i);
    if (!marker || bodyStart === -1) {
      return false;
    }
    const end = line.indexOf(`\n${marker}`, bodyStart);
    this.tokens.push("\n");
    this.i = end === -1 ? line.length : end + marker.length + 1;
    return true;
  }
}

const emptyCommand = (): Simple => ({ env: {}, words: [], redirects: [] });

/** The line's tokens grouped into simple commands. */
function splitCommands(tokens: string[]): Simple[] {
  const commands: Simple[] = [];
  let current = emptyCommand();
  const end = () => {
    if (current.words.length || current.redirects.length) {
      commands.push(current);
    }
    current = emptyCommand();
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (OPERATORS.has(token) || token === "&&" || token === "||") {
      end();
    } else {
      i += addToken(current, token, tokens[i + 1]);
    }
  }
  end();
  return commands;
}

/**
 * Adds a word, a `VAR=value` or a redirect (with `next`, its file) to a command; how many
 * tokens after this one it used.
 */
function addToken(command: Simple, token: string, next: string | undefined): number {
  // Input: its file is read, not written.
  if (token === "<") {
    return 1;
  }
  if (/^\d?&?>>?$/.test(token)) {
    if (next && next !== "/dev/null") {
      command.redirects.push(next);
    }
    return 1;
  }
  if (!command.words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
    const [key = "", ...value] = token.split("=");
    command.env[key] = value.join("=");
  } else {
    command.words.push(token);
  }
  return 0;
}

/** The command a wrapper runs (`sudo`, `env A=b`, ...), with the wrapper's variables. */
function unwrapped(command: Simple): Simple {
  const words = [...command.words];
  while (["sudo", "command", "time", "nohup", "exec"].includes(words[0] ?? "")) {
    words.shift();
  }
  if (words[0] === "env") {
    words.shift();
    while (words[0]?.includes("=")) {
      const [key = "", ...value] = (words.shift() as string).split("=");
      command.env[key] = value.join("=");
    }
  }
  return { ...command, words };
}

function simpleCommands(line: string): Simple[] {
  return splitCommands(new Lexer(line).read()).map(unwrapped);
}

const operands = (words: string[]) => words.slice(1).filter((word) => !word.startsWith("-"));

/** The files a command writes, as written (relative to its working directory). */
function writesOf({ words, redirects }: Simple): string[] {
  const [program = ""] = words;
  const targets = [...redirects];
  if (program === "tee") {
    targets.push(...operands(words));
  }
  if (["rm", "unlink", "truncate", "shred"].includes(program)) {
    targets.push(...operands(words));
  }
  if (["cp", "mv", "install", "ln", "rsync"].includes(program)) {
    const paths = operands(words);
    if (paths.length >= 2) {
      targets.push(paths.at(-1) as string);
    }
  }
  if (program === "dd") {
    targets.push(...words.filter((word) => word.startsWith("of=")).map((word) => word.slice(3)));
  }
  const inPlace = words.findIndex((word) => /^-[a-z]*i/.test(word) && !word.startsWith("--"));
  if ((program === "sed" || program === "perl") && inPlace !== -1) {
    // After the flags come the script (unless -e gave it) and then the files.
    const rest = words.slice(1).filter((word, index) => {
      if (word.startsWith("-")) {
        return false;
      }
      // macOS `sed -i ''`: the empty suffix follows -i.
      return !(word === "" && words[index] === words[inPlace]);
    });
    // The first operand is the script, whether or not -e introduced it.
    targets.push(...rest.slice(1));
  }
  return targets.filter(Boolean);
}

/** Every file the command line writes. */
export function writeTargets(line: string): string[] {
  return simpleCommands(line).flatMap(writesOf);
}

const deny = (reason: string): Verdict => ({ decision: "deny", reason });
const ask = (reason: string): Verdict => ({ decision: "ask", reason });

/**
 * Worktrunk (`wt`): making, listing and switching worktrees is routine; landing a branch,
 * deleting one, rewriting its history, approving the project's hooks or starting another
 * program in a worktree is the user's call.
 */
function worktrunkVerdict(
  sub: string,
  third: string,
  has: (...flags: string[]) => boolean,
): Verdict {
  if (sub === "merge") {
    return ask(
      "wt merge lands the branch on master locally and removes the worktree; changes reach master through pull requests.",
    );
  }
  if (sub === "remove") {
    return ask("wt remove deletes the worktree and, once merged, its branch.");
  }
  if (sub === "config") {
    return ask("wt config changes the user's Worktrunk setup (shell, plugins).");
  }
  if (
    sub === "step" &&
    ["commit", "squash", "push", "rebase", "promote", "prune", "relocate"].includes(third)
  ) {
    return ask(
      `wt step ${third} commits, rewrites or moves branches; it needs the user's approval.`,
    );
  }
  if (has("--yes", "-y")) {
    return ask("--yes approves the project's hooks without the user seeing them first.");
  }
  if (sub === "switch" && has("-x", "--execute")) {
    return ask("wt switch -x starts another program (often another agent) in the worktree.");
  }
  return null;
}

/** Whether a docker command stops or deletes something (`compose down`, `volume rm`, ...). */
function dockerRemoves([, sub = "", third = "", ...rest]: string[]) {
  if (["rm", "rmi", "kill", "stop"].includes(sub)) {
    return true;
  }
  // Past compose's own flags (`-p x`, `--profile full`).
  if (sub === "compose") {
    return [third, ...rest].some((word) => ["down", "rm", "kill", "stop"].includes(word));
  }
  const objects = ["volume", "container", "image", "network", "system", "builder", "buildx"];
  return objects.includes(sub) && ["rm", "prune"].includes(third);
}

/** A command's words, and whether it has any of some flags. */
type Command = { words: string[]; has: (...flags: string[]) => boolean };

/** git commit and push: skipping the hooks or force-pushing is refused; either needs a yes. */
function gitPublishVerdict({ words, has }: Command): Verdict {
  const [, sub = ""] = words;
  // `-n` is commit's short --no-verify, alone or among other short flags.
  const shortNoVerify = words.some((word) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(word));
  if (has("--no-verify") || (sub === "commit" && shortNoVerify)) {
    return deny("--no-verify skips the commit and push hooks' checks. Fix what they report.");
  }
  if (sub === "commit") {
    return ask("Commits need the user's approval (CLAUDE.md).");
  }
  if (has("--force", "-f") || words.some((word) => /^\+/.test(word))) {
    return deny("Force-pushing rewrites shared history; the user does that by hand if ever.");
  }
  if (words.some((word) => word.startsWith("--force-with-lease"))) {
    return ask("A force push (--force-with-lease) rewrites the branch's history.");
  }
  return ask("Pushing publishes the branch; it needs the user's approval.");
}

/** git: history and shared state need a yes. */
function gitVerdict(command: Command): Verdict {
  const { words, has } = command;
  const [, sub = "", third = ""] = words;
  if (sub === "commit" || sub === "push") {
    return gitPublishVerdict(command);
  }
  if (sub === "branch" && has("-D", "--delete")) {
    return ask("Deleting a branch loses its commits.");
  }
  if (sub === "reset" && has("--hard")) {
    return ask("git reset --hard discards uncommitted work.");
  }
  if (sub === "clean") {
    return ask("git clean deletes untracked files.");
  }
  // Read-only forms are fine; anything else swaps work in and out of a stack every
  // worktree shares, so one session's stash can land in another's tree.
  if (sub === "stash" && !["list", "show"].includes(third)) {
    return ask(
      "git stash is shared by every worktree of this repository; commit the work, or use another worktree (`wt switch --create`).",
    );
  }
  if (sub === "worktree" && third === "add") {
    return ask(
      "Make worktrees with `wt switch --create <branch>` (.config/wt.toml copies .env and installs).",
    );
  }
  return null;
}

const GITHUB_ACCOUNT_COMMANDS = new Set([
  "api",
  "release",
  "secret",
  "variable",
  "repo",
  "workflow",
]);

/** gh: anything that changes GitHub needs a yes. */
function ghVerdict({ words }: Command): Verdict {
  const [, sub = "", third = ""] = words;
  if (sub === "pr" && ["create", "merge", "close", "comment", "review", "edit"].includes(third)) {
    return ask("This changes a pull request on GitHub; it needs the user's approval.");
  }
  if (GITHUB_ACCOUNT_COMMANDS.has(sub)) {
    return ask("This reaches GitHub on the user's account; it needs their approval.");
  }
  return null;
}

/** The repo's scripts that push, promote or delete (by `bun run` name or file). */
const DESTRUCTIVE_SCRIPTS: Record<string, string> = {
  promote: "Opens a production promotion: a branch, a commit, a push and a pull request.",
  "scripts/release.ts": "Releases and promotes: pushes to GitHub.",
  "docker:clean": "Deletes every local volume (databases included).",
  "scripts/docker-clean.ts": "Deletes every local volume (databases included).",
  "k8s:down": "Deletes the local cluster.",
  "db:reset": "Resets the local database.",
};

/** bun: new dependencies and the scripts that push, promote or delete need a yes. */
function bunVerdict({ words }: Command): Verdict {
  const [, sub = "", third = ""] = words;
  // A new dependency is code from outside: the user picks it (and Renovate waits 3 days
  // for any release; bunfig.toml makes `bun add` wait too).
  if (sub === "add") {
    return ask("Adding a dependency brings in outside code; the user decides.");
  }
  const script = sub === "run" ? third : sub;
  const destructive = DESTRUCTIVE_SCRIPTS[script];
  if (destructive) {
    return ask(destructive);
  }
  if (words.includes("reset") && words.some((word) => word.includes("@repo/db"))) {
    return ask("Resets the local database (prisma migrate reset).");
  }
  return null;
}

/** bunx: only the workspace's own tools, and no database changes outside a migration. */
function bunxVerdict({ words, has }: Command, installed: (bin: string) => boolean): Verdict {
  const [, sub = "", third = ""] = words;
  // Without the workspace's copy, bunx downloads whatever npm package has that name, and
  // runs it: `bunx biome` before `bun install` is someone else's "biome".
  if (sub && !sub.startsWith("-") && !installed(sub)) {
    return ask(
      `${sub} isn't installed here, so bunx would download and run npm's "${sub}". Run \`bun install\` first.`,
    );
  }
  if (sub === "prisma" && ["db", "migrate"].includes(third) && has("push", "execute", "reset")) {
    return ask("This changes or wipes the database outside a migration.");
  }
  return null;
}

/** What the policy says about one simple command, or null. */
function commandVerdict({ env, words }: Simple, installed: (bin: string) => boolean): Verdict {
  const [program = "", sub = "", third = ""] = words;
  const command: Command = { words, has: (...flags) => words.some((word) => flags.includes(word)) };
  if (env.HUSKY === "0" || env.HUSKY_SKIP_HOOKS) {
    return deny(
      "Skipping the commit hooks (HUSKY=0) skips the checks they run. Fix what they report.",
    );
  }
  switch (program) {
    case "git":
      return gitVerdict(command);
    case "gh":
      return ghVerdict(command);
    case "bun":
      return bunVerdict(command);
    case "bunx":
      return bunxVerdict(command, installed);
    case "wt":
      return worktrunkVerdict(sub, third, command.has);
    // Docker is shared by every checkout and every other project on the machine.
    case "docker":
      return dockerRemoves(words)
        ? ask(
            "This stops or deletes Docker containers, volumes or images that other checkouts and projects may use.",
          )
        : null;
    case "uv":
      return sub === "add"
        ? ask("Adding a dependency brings in outside code; the user decides.")
        : null;
    case "sops":
      if (command.has("-d", "--decrypt") || sub === "decrypt") {
        return deny(
          "Decrypting a secrets file puts its values in the conversation. The user edits it with `sops <file>`.",
        );
      }
      return null;
    case "tofu":
      if (["apply", "destroy", "import", "state"].includes(sub)) {
        return ask("This changes real infrastructure or its state.");
      }
      return null;
    default:
      return null;
  }
}

/** The strictest verdict any command on the line gets (deny beats ask). */
export function commandPolicy(line: string, installed = installedBin): Verdict {
  const verdicts = simpleCommands(line)
    .map((command) => commandVerdict(command, installed))
    .filter((verdict) => verdict !== null);
  return verdicts.find((verdict) => verdict.decision === "deny") ?? verdicts[0] ?? null;
}
