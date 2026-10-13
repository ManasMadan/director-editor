/**
 * Every queue processor extends JobProcessor, which logs failed jobs; one extending
 * WorkerHost directly would fail silently (@nestjs/bullmq binds only declared events).
 */
import { describe, expect, it } from "bun:test";

describe("queue processors", () => {
  it("extend JobProcessor, never WorkerHost directly", async () => {
    const offenders: string[] = [];
    for await (const path of new Bun.Glob("{apps,packages}/*/src/**/*.ts").scan(
      `${import.meta.dir}/..`,
    )) {
      if (path.endsWith("packages/nest-common/src/job-processor.ts")) {
        continue;
      }
      const text = await Bun.file(`${import.meta.dir}/../${path}`).text();
      if (/extends\s+WorkerHost\b/.test(text)) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});
