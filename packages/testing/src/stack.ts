/**
 * A second (third, ...) copy of the local services and apps for another checkout of this
 * repo on the same machine, such as a worktree an agent works in: its own compose
 * project, so its own containers and volumes, and every port moved by 100 per stack, the
 * services' and the apps' (`WEB_PORT`, `API_PORT`, ...), so both checkouts can run
 * `bun dev` and the e2e run at once.
 * `bun run setup --stack <n>` writes the stack's values into that checkout's .env, and
 * the same moves applied to .env.example into `.env.stack` (ports and local URLs, no
 * secrets), which the tests' environment lays over .env.example (environment.ts here,
 * apps/ai/tests/__init__.py), so `bun dev`, the scripts and the tests all use that
 * checkout's services. Stack 0 is the default, the ports in .env.example.
 */

/** The tests' view of a checkout's stack, next to .env; none for stack 0. */
export const STACK_FILE = ".env.stack";
/** How many stacks fit: the ports stay distinct across stacks 0 to 9 (stack.test.ts). */
export const STACKS = 10;
const STEP = 100;

/** The ports .env.example names (every `*_PORT`, services' and apps'), with their defaults. */
export function defaultPorts(example: Record<string, string>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(example)
      .filter(([key, value]) => key.endsWith("_PORT") && /^\d+$/.test(value))
      .map(([key, value]) => [key, Number(value)]),
  );
}

/** Each port that isn't yet where `stack` puts it, and the old value each moves from. */
function movedPorts(
  current: Record<string, string>,
  example: Record<string, string>,
  stack: number,
) {
  const changes: Record<string, string> = {};
  const moved = new Map<string, string>();
  for (const [key, port] of Object.entries(defaultPorts(example))) {
    const next = String(port + stack * STEP);
    const now = current[key] ?? String(port);
    if (now === next) {
      continue;
    }
    changes[key] = next;
    moved.set(now, next);
  }
  return { changes, moved };
}

/** A local URL with any port that moved pointed at its new one. */
const repointed = (value: string, moved: Map<string, string>) =>
  value.replace(
    /\b(localhost|127\.0\.0\.1):(\d+)\b/g,
    (match: string, host: string, port: string) =>
      moved.has(port) ? `${host}:${moved.get(port)}` : match,
  );

/**
 * What changes in `current` (a .env's values) for `stack`: every port moved to its
 * default plus 100 per stack, every local URL naming a port that moved pointed at the
 * new one, and, given the compose `project`, its name for this stack.
 */
export function stackValues(
  current: Record<string, string>,
  example: Record<string, string>,
  stack: number,
  project?: string,
): Record<string, string> {
  if (!Number.isInteger(stack) || stack < 0 || stack >= STACKS) {
    throw new Error(`A stack is a whole number from 0 to ${STACKS - 1}, not ${stack}.`);
  }
  const { changes, moved } = movedPorts(current, example, stack);
  for (const [key, value] of Object.entries(current)) {
    const url = repointed(value, moved);
    if (!(key in changes) && url !== value) {
      changes[key] = url;
    }
  }
  if (project !== undefined) {
    const name = stack === 0 ? project : `${project}-stack${stack}`;
    if (current.COMPOSE_PROJECT_NAME !== name) {
      changes.COMPOSE_PROJECT_NAME = name;
    }
  }
  return changes;
}
