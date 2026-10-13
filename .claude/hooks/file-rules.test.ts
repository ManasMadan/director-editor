import { describe, expect, it } from "bun:test";
import { verdictFor } from "./file-rules";

const decision = (path: string, extra: Partial<Parameters<typeof verdictFor>[0]> = {}) =>
  verdictFor({ path, ...extra })?.decision ?? "allow";

describe("the file rules", () => {
  it.each([
    [".env", "deny"],
    ["apps/api/.env", "deny"],
    [".env.local", "deny"],
    [".envrc", "deny"],
    [".env.example", "allow"],
    ["deploy/environments/staging/secrets/api.sops.yaml", "deny"],
    [".sops.yaml", "ask"],
    ["apps/api/openapi.json", "deny"],
    ["packages/db/src/generated/prisma/client.ts", "deny"],
    ["apps/ai/app/contracts/jobs.py", "deny"],
    ["apps/mobile/uniwind-types.d.ts", "deny"],
    ["bun.lock", "deny"],
    ["apps/ai/uv.lock", "deny"],
    ["infra/tofu/envs/k3s/.terraform.lock.hcl", "deny"],
    ["packages/db/prisma/migrations/migration_lock.toml", "deny"],
    [".claude/settings.json", "ask"],
    [".claude/hooks/guard-files.ts", "ask"],
    [".claude-plugin/plugin.json", "ask"],
    [".husky/pre-commit", "ask"],
    ["biome.jsonc", "ask"],
    [".gitleaksignore", "ask"],
    ["apps/api/src/main.ts", "allow"],
    ["docs/testing.md", "allow"],
  ])("%s: %s", (path, expected) => {
    expect(decision(path)).toBe(expected);
  });

  it("allow a migration until it has shipped", () => {
    const migration = "packages/db/prisma/migrations/20260101000000_x/migration.sql";
    expect(decision(migration)).toBe("allow");
    expect(decision(migration, { shipped: true })).toBe("deny");
  });

  it("keep image tags to CI, and the rest of an environment's values editable", () => {
    const values = "deploy/environments/production/stack.yaml";
    expect(decision(values, { before: '  tag: "sha-1"', after: '  tag: "sha-2"' })).toBe("deny");
    expect(decision(values, { before: "  replicas: 2", after: "  replicas: 3" })).toBe("allow");
    const release = "deploy/environments/production/release.yaml";
    expect(decision(release, { before: "revision: v1.2.0", after: "revision: v1.1.0" })).toBe(
      "deny",
    );
  });
});
