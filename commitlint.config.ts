/**
 * Commit messages follow Conventional Commits (`feat(api): add todo sharing`), which
 * scripts/release.ts turns into release notes. A scope is a workspace's folder name (read
 * from apps/ and packages/ here, so a new one is a scope at once), `load`, or one of the
 * cross-cutting ones below. CI checks pull request titles with this same config.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { UserConfig } from "@commitlint/types";

/** Changes that belong to no one workspace. */
const CROSS_CUTTING = ["repo", "deps", "ci", "infra", "claude", "docs", "load"];

const workspaces = ["apps", "packages"].flatMap((dir) =>
  readdirSync(join(import.meta.dirname, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
);

const config: UserConfig = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [2, "always", [...CROSS_CUTTING, ...workspaces].sort()],
    "subject-case": [2, "never", ["upper-case", "pascal-case", "start-case"]],
    "body-max-line-length": [1, "always", 100],
  },
};

export default config;
