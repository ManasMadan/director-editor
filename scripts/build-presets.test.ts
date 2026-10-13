/** The presets every package builds and tests with: packages/vitest-config and tsdown-config. */
import { describe, expect, it } from "bun:test";
import { nodeService } from "../packages/tsdown-config";
import { coverage, decoratorMetadata, tags } from "../packages/vitest-config";

describe("the vitest preset", () => {
  it("reports every file the tests load as LCOV, leaving out tests, generated code and configs", () => {
    const options = coverage();
    expect(options).toMatchObject({ provider: "v8", allowExternal: true, reporter: ["lcov"] });
    expect("exclude" in options && options.exclude).toEqual(
      expect.arrayContaining(["**/*.test.{ts,tsx}", "**/generated/**", "**/*.config.{ts,mts}"]),
    );
    expect(tags.map((tag) => tag.name)).toEqual(["files"]);
  });

  it("compiles the import-cycle guard of injected parameters away, keeping each length", () => {
    const { transform } = decoratorMetadata();
    expect(transform("const a = 1;")).toBeUndefined();
    const users = 'typeof UsersService === "undefined" ? Object : UsersService';
    const db = 'typeof Db === "undefined" ? Object : Db';
    const code = `type: ${users}, x: ${db}`;
    const result = transform(code);
    expect(result?.code).toBe(
      `type: ${"UsersService".padEnd(users.length)}, x: ${"Db".padEnd(db.length)}`,
    );
    expect(result?.code.length).toBe(code.length);
  });
});

describe("the Node service preset", () => {
  it("bundles our packages into one ESM build per entry, and takes overrides", () => {
    expect(nodeService()).toMatchObject({
      entry: ["src/main.ts", "src/telemetry.ts"],
      format: "esm",
      deps: { neverBundle: true, alwaysBundle: [/^@repo\//] },
    });
    expect(nodeService({ entry: ["src/worker.ts"] }).entry).toEqual(["src/worker.ts"]);
  });
});
