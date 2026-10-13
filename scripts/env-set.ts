/**
 * Sets one variable in .env without printing the file.
 *
 *   bun run env:set STRIPE_SECRET_KEY=sk_test_...
 *   echo "sk_test_..." | bun run env:set STRIPE_SECRET_KEY   # value from stdin, not argv
 *
 * Claude is not allowed to read .env (it holds secrets), so this is how a prompt like
 * "use my Stripe test key" gets applied.
 */
import { ENV_PATH, messageOf, ok, runMain, writeEnvValue } from "./lib";

/** Sets `KEY=value` (or KEY to what `stdin` holds) in the file at `path`; the exit code. */
export async function envSet(
  argv = process.argv.slice(2),
  path = ENV_PATH,
  stdin: { text(): Promise<string> } = Bun.stdin,
): Promise<number> {
  const [arg] = argv;
  if (!arg) {
    console.error(
      "Usage: bun run env:set KEY=value   (or pipe the value on stdin: bun run env:set KEY)",
    );
    return 1;
  }
  const [key, ...rest] = arg.split("=");
  if (!key || !/^[A-Z][A-Z0-9_]*$/.test(key)) {
    console.error(`Invalid variable name "${key}". Use UPPER_SNAKE_CASE.`);
    return 1;
  }
  const value = rest.length > 0 ? rest.join("=") : (await stdin.text()).trim();
  try {
    writeEnvValue(path, key, value);
  } catch (error) {
    console.error(messageOf(error));
    return 1;
  }
  ok(`${key} updated in .env`);
  return 0;
}

await runMain(import.meta, envSet);
