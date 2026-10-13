/**
 * Every variable a service reads is in .env.example (set, or commented out with its
 * default) and in docs/environment.md, so a new one can't reach a deploy undocumented and
 * only fail at boot. The Python service's settings have the same test in apps/ai.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { testEnvironment } from "../packages/testing/src/environment";

const ROOT = join(import.meta.dir, "..");
const example = readFileSync(join(ROOT, ".env.example"), "utf8");
const docs = readFileSync(join(ROOT, "docs/environment.md"), "utf8");
const SERVICES = ["api", "notifications", "webhooks", "worker", "web"];

// Imported at run time, not statically: the schemas validate on import, so the test
// environment must be in place first (and the services' decorators stay out of the
// scripts' type-check).
const schemas = new Map<string, string[]>();
beforeAll(async () => {
  Object.assign(process.env, { ...testEnvironment(join(ROOT, ".env.example")), ...process.env });
  for (const service of SERVICES) {
    const { envSchema } = await import(join(ROOT, "apps", service, "src/env.ts"));
    schemas.set(service, Object.keys(envSchema));
  }
});

describe.each(SERVICES)("the %s service's variables", (service) => {
  it("are all in .env.example", () => {
    const missing = (schemas.get(service) ?? []).filter(
      (key) => !new RegExp(`^#? ?${key}=`, "m").test(example),
    );
    expect(missing).toEqual([]);
  });

  it("are all in docs/environment.md", () => {
    const missing = (schemas.get(service) ?? []).filter((key) => !docs.includes(`\`${key}\``));
    expect(missing).toEqual([]);
  });
});
