/**
 * The command itself is tested against a real Valkey with packages/jobs's integration
 * tests (test/cli.integration.test.ts); this only loads the entry point.
 */
import { describe, expect, it } from "bun:test";

describe("bun run jobs", () => {
  it("loads without connecting anywhere", async () => {
    expect(Object.keys(await import("./jobs"))).toEqual([]);
  });
});
