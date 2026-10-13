import { describe, expect, it } from "bun:test";
import { commandPolicy, writeTargets } from "./shell";

describe("the files a command writes", () => {
  it.each([
    ["echo hi > .env", [".env"]],
    ["echo hi >> a.txt", ["a.txt"]],
    ["make 2> err.log", ["err.log"]],
    ["make &> all.log", ["all.log"]],
    ["make 2>&1 | tee -a out.log", ["out.log"]],
    ["cmd > /dev/null 2>&1", []],
    ["sed -i 's/a/b/' bun.lock other.ts", ["bun.lock", "other.ts"]],
    ["sed -i '' 's/a/b/' bun.lock", ["bun.lock"]],
    ["sed -i.bak -e 's/a/b/' file.ts", ["file.ts"]],
    ["sed 's/a/b/' file.ts", []],
    ["perl -pi -e 's/a/b/' x.sql", ["x.sql"]],
    [
      "cp a.json packages/db/prisma/migrations/1_x/migration.sql",
      ["packages/db/prisma/migrations/1_x/migration.sql"],
    ],
    ["mv -f new.lock bun.lock", ["bun.lock"]],
    ["rm -rf apps/ai/app/contracts", ["apps/ai/app/contracts"]],
    ["dd if=/dev/zero of=disk.img bs=1", ["disk.img"]],
    ["cd x && echo '> not a redirect' && cat \"quoted > file\"", []],
    [
      "cat > notes.md <<'EOF'\nline > with redirect\nrm .env\nEOF\necho done > done.txt",
      ["notes.md", "done.txt"],
    ],
    ["sudo tee /etc/hosts < file", ["/etc/hosts"]],
    ["echo hi > my\\ notes.md", ["my notes.md"]],
  ])("%s", (command, expected) => {
    expect(writeTargets(command)).toEqual(expected);
  });
});

describe("the command policy", () => {
  const decision = (command: string) => commandPolicy(command)?.decision ?? "allow";
  it("asks before bunx fetches a tool the workspace doesn't have", () => {
    const none = () => false;
    expect(commandPolicy("bunx biome check .", none)).toEqual({
      decision: "ask",
      reason:
        "biome isn't installed here, so bunx would download and run npm's \"biome\". Run `bun install` first.",
    });
    expect(commandPolicy("bunx --bun vite", none)).toBeNull();
    expect(commandPolicy("bunx biome check .", (bin) => bin === "biome")).toBeNull();
    // This checkout has its tools installed.
    expect(decision("bunx tsc -p scripts")).toBe("allow");
  });

  it.each([
    ["git commit -m 'fix: x'", "ask"],
    ["git commit --no-verify -m x", "deny"],
    ["git commit -nm x", "deny"],
    ["HUSKY=0 git commit -m x", "deny"],
    ["env HUSKY=0 git commit -m x", "deny"],
    ["git push origin main", "ask"],
    ["git push --force", "deny"],
    ["git push -f origin main", "deny"],
    ["git push origin +main", "deny"],
    ["git push --force-with-lease", "ask"],
    ["git push --no-verify", "deny"],
    ["git branch -D old", "ask"],
    ["git branch --list", "allow"],
    ["git reset --hard HEAD~1", "ask"],
    ["git status && git diff", "allow"],
    ["gh pr create --fill", "ask"],
    ["gh pr view 1", "allow"],
    ["gh api repos/x/y", "ask"],
    ["gh release delete v1 --cleanup-tag", "ask"],
    ["gh run list", "allow"],
    ["sops -d secrets.sops.yaml", "deny"],
    ["sops decrypt secrets.sops.yaml", "deny"],
    ["sops secrets.sops.yaml", "allow"],
    ["tofu destroy -var-file=x", "ask"],
    ["tofu plan", "allow"],
    ["bun run promote v1.0.0", "ask"],
    ["bun scripts/release.ts promote v1", "ask"],
    ["bun run docker:clean", "ask"],
    ["bun run k8s:down", "ask"],
    ["bun run --filter @repo/db reset", "ask"],
    ["bunx prisma db push --force-reset", "ask"],
    ["git stash", "ask"],
    ["git stash pop", "ask"],
    ["git stash list", "allow"],
    ["git worktree add ../x", "ask"],
    ["git worktree list", "allow"],
    ["wt switch --create feat/x", "allow"],
    ["wt list", "allow"],
    ["wt step diff", "allow"],
    ["wt merge", "ask"],
    ["wt remove feat/x", "ask"],
    ["wt config plugins claude install", "ask"],
    ["wt step commit", "ask"],
    ["wt step push", "ask"],
    ["wt switch --create feat/x --yes", "ask"],
    ["wt hook pre-merge -y", "ask"],
    ["wt switch -x claude -c feat/x", "ask"],
    ["bunx prisma db execute --file x.sql", "ask"],
    ["docker compose down", "ask"],
    ["docker compose --profile full down -v", "ask"],
    ["docker volume rm boilerplate_postgres", "ask"],
    ["docker system prune -af", "ask"],
    ["docker rm -f postgres", "ask"],
    ["docker buildx prune", "ask"],
    ["docker compose ps", "allow"],
    ["docker volume ls", "allow"],
    ["bun run test", "allow"],
    ["bun add zod", "ask"],
    ["uv add httpx", "ask"],
    ["bun install", "allow"],
    ["git status; git commit -m x --no-verify", "deny"],
  ])("%s: %s", (command, expected) => {
    expect(decision(command)).toBe(expected);
  });
});
