import { afterEach, describe, expect, it, mock } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityFrom, leftovers, main, OLD, rename, rewrite } from "./rename";
import { captureOutput, fakeRun } from "./stand-ins";

const ROOT = join(import.meta.dir, "..");
afterEach(() => mock.restore());

/** A git repository holding `files`. */
function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "rename-"));
  for (const [path, text] of Object.entries(files)) {
    writeFileSync(join(dir, path), text);
  }
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
  return dir;
}

const acme = identityFrom(["shop", "--owner", "Acme-Co", "--product", "Acme Shop"]);

describe("renaming the project", () => {
  it("rewrites every kind of identifier the template uses", () => {
    const lines = {
      [`repoURL: https://github.com/${OLD.owner}/${OLD.name}.git`]:
        "repoURL: https://github.com/Acme-Co/shop.git",
      [`image: ghcr.io/${OLD.owner.toLowerCase()}/${OLD.name}/api`]:
        "image: ghcr.io/acme-co/shop/api",
      [`* @${OLD.owner}`]: "* @Acme-Co",
      [`bundleIdentifier: "${OLD.bundleId}.development"`]:
        'bundleIdentifier: "com.shop.app.development"',
      [`APNS_BUNDLE_ID: "dev.${OLD.name}.app"`]: 'APNS_BUNDLE_ID: "com.shop.app"',
      [`appName: "${OLD.product}"`]: 'appName: "Acme Shop"',
      [`${OLD.name}.dev/component: api`]: "shop.dev/component: api",
      [`http://${OLD.name}-webhooks.${OLD.name}.svc.cluster.local`]:
        "http://shop-webhooks.shop.svc.cluster.local",
      [`EMAIL_FROM=no-reply@${OLD.name}.test`]: "EMAIL_FROM=no-reply@shop.test",
    };
    for (const [before, after] of Object.entries(lines)) {
      expect(rewrite(before, acme)).toBe(after);
    }
  });

  it("never rewrites what it wrote: a lowercase owner leaves the registry path lowercase", () => {
    const lower = identityFrom(["shop", "--owner", "Acme-Co"]);
    const owner = OLD.owner.toLowerCase();
    expect(rewrite(`ghcr.io/${owner}/${OLD.name}/api and @${OLD.owner}`, lower)).toBe(
      "ghcr.io/acme-co/shop/api and @Acme-Co",
    );
  });

  it("writes the product as given, `$` and all", () => {
    const pricey = identityFrom(["shop", "--owner", "me", "--product", "Shop $& $$ $1"]);
    expect(rewrite(`appName: "${OLD.product}"`, pricey)).toBe('appName: "Shop $& $$ $1"');
  });

  it("derives the product and bundle id from the name", () => {
    expect(identityFrom(["my-app", "--owner", "me"])).toEqual({
      name: "my-app",
      owner: "me",
      product: "My-app",
      bundleId: "com.myapp.app",
    });
    expect(identityFrom(["x", "--owner", "me", "--bundle-id", "io.me.x"]).bundleId).toBe("io.me.x");
  });

  it.each([
    [["Shop", "--owner", "me"], /lowercase/],
    [["shop"], /--owner/],
    [["shop", "--owner", "me/you"], /--owner/],
    [[OLD.name, "--owner", "me"], /already/],
    [["shop", "--owner", "me", "--bundle-id", "shop"], /reverse DNS/],
  ])("refuses %j", (argv, message) => {
    expect(() => identityFrom(argv)).toThrow(message);
  });

  it("names every line still mentioning the template", () => {
    const token = `${OLD.name.toUpperCase()}_TOKEN`;
    const owner = OLD.owner.toLowerCase();
    const files = new Map([
      ["a.md", `fine\nsee ${token}\nok`],
      ["b.ts", `// ${owner}`],
    ]);
    expect(leftovers(files)).toEqual([`a.md:2: see ${token}`, `b.ts:1: // ${owner}`]);
    // Renaming only the project keeps the owner: its name in the new URLs isn't left over.
    const sameOwner = identityFrom(["shop", "--owner", OLD.owner]);
    expect(leftovers(files, sameOwner)).toEqual([`a.md:2: see ${token}`]);
    const sameEverything = { ...sameOwner, name: OLD.name.toUpperCase() };
    expect(leftovers(files, sameEverything)).toEqual([]);
  });

  it("leaves nothing of the template in a copy of this repository", () => {
    // A throwaway git repository with this checkout's tracked files.
    const dir = mkdtempSync(join(tmpdir(), "rename-"));
    const tracked = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT })
      .stdout.toString()
      .split("\0")
      .filter(Boolean);
    for (const path of tracked) {
      try {
        cpSync(join(ROOT, path), join(dir, path), { recursive: true });
      } catch {
        // Deleted in the working tree but still in the index: nothing to copy.
      }
    }
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
    writeFileSync(join(dir, "binary.bin"), Buffer.from([0, 1, 2, 0x62, 0x6f]));
    Bun.spawnSync(["git", "add", "binary.bin"], { cwd: dir });

    const { changed, left } = rename(dir, acme);
    expect(left).toEqual([]);
    expect(changed.length).toBeGreaterThan(50);
    expect(readFileSync(join(dir, "apps/mobile/app.config.ts"), "utf8")).toContain("com.shop.app");
    expect(readFileSync(join(dir, "binary.bin"))).toEqual(Buffer.from([0, 1, 2, 0x62, 0x6f]));
    // Renamed again later from what it's called now; captured requests keep their bytes.
    expect(readFileSync(join(dir, "scripts/rename.ts"), "utf8")).toContain(
      'name: "shop",\n  owner: "Acme-Co",\n  product: "Acme Shop",\n  bundleId: "com.shop.app",',
    );
    const captured = "apps/webhooks/src/inbound/stalwart-events.test.ts";
    expect(readFileSync(join(dir, captured), "utf8")).toBe(
      readFileSync(join(ROOT, captured), "utf8"),
    );
  }, 60_000);

  it("says what it did, and fails on what it couldn't rename", () => {
    const printed = captureOutput();
    const { run, calls } = fakeRun();
    expect(main(["shop", "--owner", "acme"], repo({ "a.md": OLD.name }), run)).toBe(0);
    expect(calls).toEqual([
      "bunx biome format --write --files-ignore-unknown=true --no-errors-on-unmatched a.md",
    ]);
    const key = `${OLD.name.toUpperCase()}_KEY`;
    expect(main(["shop", "--owner", "acme"], repo({ "a.md": key }), run)).toBe(1);
    expect(main(["Shop", "--owner", "acme"], repo({}), run)).toBe(1);
    expect(printed()).toContain("1 files rewritten for acme/shop");
    expect(printed()).toContain(`a.md:1: ${key}`);
    expect(printed()).toContain("lowercase letters");
  });
});
