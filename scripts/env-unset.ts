/**
 * Removes one variable from .env without printing the file.
 *
 *   bun run env:unset OLD_VARIABLE [ANOTHER ...]
 */
import { ENV_PATH, ok, removeEnvValue, runMain, warn } from "./lib";

/** Removes each KEY in `argv` from the file at `path`; the exit code. */
export function envUnset(argv = process.argv.slice(2), path = ENV_PATH): number {
  if (argv.length === 0 || argv.some((key) => !/^[A-Z][A-Z0-9_]*$/.test(key))) {
    console.error("Usage: bun run env:unset KEY [KEY ...]   (UPPER_SNAKE_CASE)");
    return 1;
  }
  for (const key of argv) {
    if (removeEnvValue(path, key)) {
      ok(`${key} removed from .env`);
    } else {
      warn(`${key} isn't in .env`);
    }
  }
  return 0;
}

await runMain(import.meta, envUnset);
