/**
 * Which files Claude may not write, and which need the user's say-so, whichever tool the
 * write comes from: guard-files.ts applies them to Edit and Write, bash-guard.ts to
 * shell commands that write files. Pure, so the table is tested (file-rules.test.ts).
 */

export type Verdict = { decision: "deny" | "ask"; reason: string } | null;

export interface Change {
  /** Repo-relative path. */
  path: string;
  /** Whether the file is on the default branch (it has shipped). */
  shipped?: boolean;
  /** The text being replaced and the text replacing it, when the tool says. */
  before?: string;
  after?: string;
}

const deny = (reason: string): Verdict => ({ decision: "deny", reason });
const ask = (reason: string): Verdict => ({ decision: "ask", reason });

const ENV_FILE = /(^|\/)\.env(rc|\..+)?$/;
const GENERATED =
  /(^|\/)generated\/|\.gen\.ts$|(^|\/)openapi\.json$|^apps\/ai\/app\/contracts\/|^apps\/mobile\/uniwind-types\.d\.ts$/;
const LOCKFILE =
  /(^|\/)(bun\.lock|uv\.lock|\.terraform\.lock\.hcl)$|^packages\/db\/prisma\/migrations\/migration_lock\.toml$/;
const MIGRATION = /prisma\/migrations\/[^/]+\/migration\.sql$/;
const ENVIRONMENT_VALUES = /^deploy\/environments\/[^/]+\/(stack|release)\.yaml$/;
// An image tag, or the git revision production deploys from (release.yaml).
const IMAGE_TAG = /^\s*(tag|imageTag|revision):/m;
/**
 * The agent's own guard rails: hooks, permissions, the plugin that ships them to other
 * apps, the commit hooks and the lint and dependency rules. A change to one needs the
 * user to look at it.
 */
const GUARD_RAILS =
  /^(\.claude\/settings\.json|\.claude\/hooks\/|\.claude-plugin\/|\.husky\/|biome\.jsonc$|knip\.jsonc$|\.dependency-cruiser\.cjs$|\.gitleaksignore$|\.trivyignore\.yaml$|osv-scanner\.toml$|\.sops\.yaml$)/;

/** The rule for one change, or null when it's allowed. */
export function verdictFor({ path, shipped = false, before, after }: Change): Verdict {
  if (ENV_FILE.test(path) && !path.endsWith(".env.example")) {
    return deny(
      "Environment files hold secrets and are not edited by Claude. Use `bun run env:set KEY=value`, and add new variables to .env.example.",
    );
  }
  // An encrypted file, not `.sops.yaml` itself (who can decrypt what: a guard rail).
  if (path.endsWith(".sops.yaml") && path !== ".sops.yaml") {
    return deny(
      "SOPS files are encrypted and carry a MAC over their content, so a direct edit breaks them. The user edits them with `sops <file>` (the rotate-secrets skill).",
    );
  }
  if (GENERATED.test(path)) {
    return deny(
      "This file is generated. Change its source (Prisma schema, Pydantic models, contracts) and run `bun run gen`.",
    );
  }
  if (LOCKFILE.test(path)) {
    return deny(
      "Lockfiles are written by their tools: `bun add`/`bun remove`, `uv add`, `tofu init -upgrade`, `bun run db:migrate`.",
    );
  }
  // Shipped migrations are history: editing one desynchronises every database that ran
  // it. One that isn't on the default branch yet still gets its policies and grants.
  if (MIGRATION.test(path) && shipped) {
    return deny(
      "This migration has shipped, so it's immutable. Create a new one with `bun run db:migrate` (see the db-change skill).",
    );
  }
  // CI writes the image tags (staging on each merge, production through a promotion).
  if (
    ENVIRONMENT_VALUES.test(path) &&
    [before, after].some((text) => text && IMAGE_TAG.test(text))
  ) {
    return deny(
      "Image tags and the release revision in deploy/environments are written by CI (deploy.yml for staging, `bun run promote` for production). Roll back with the rollback skill.",
    );
  }
  if (GUARD_RAILS.test(path)) {
    return ask(
      "This file is one of Claude's own guard rails (hooks, permissions, commit hooks, lint or dependency rules, reviewed security exceptions). The user decides on changes to it.",
    );
  }
  return null;
}
