/**
 * JobProcessor, in a real Nest app with BullMQ on the docker compose Valkey: a failing
 * job is logged, from the handlers the base class declares (which @nestjs/bullmq has to
 * find on the subclass), an unrecoverable one isn't retried, and every run, done or failed,
 * writes its activity line.
 */
import { randomUUID } from "node:crypto";
import { BullModule, Processor } from "@nestjs/bullmq";
import { type LoggerService, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { eventually } from "@repo/testing/eventually";
import { Queue, UnrecoverableError } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JobProcessor } from "../src/job-processor";
import { redisDatabase } from "../src/testing";

const QUEUE = `job-processor-test-${randomUUID()}`;
const connection = { url: redisDatabase(12) };

@Processor(QUEUE)
class FailingProcessor extends JobProcessor {
  async process(job: { data: { kind: string } }) {
    if (job.data.kind === "good") {
      return;
    }
    if (job.data.kind === "bad") {
      throw new UnrecoverableError("bad payload");
    }
    throw new Error("outer", { cause: new Error("the real reason") });
  }
}

@Module({
  imports: [BullModule.forRoot({ connection }), BullModule.registerQueue({ name: QUEUE })],
  providers: [FailingProcessor],
})
class TestModule {}

const errors: unknown[][] = [];
const infos: unknown[][] = [];
const warnings: unknown[][] = [];
const logger: LoggerService = {
  log: (...args: unknown[]) => void infos.push(args),
  warn: (...args: unknown[]) => void warnings.push(args),
  error: (...args: unknown[]) => void errors.push(args),
};

let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;
let queue: Queue;
beforeAll(async () => {
  app = await NestFactory.createApplicationContext(TestModule, { logger });
  await app.init();
  queue = new Queue(QUEUE, { connection });
});
afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  await app.close();
});

function failedLog(jobId: string) {
  return eventually(
    () => errors.find((args) => (args[0] as { jobId?: string })?.jobId === jobId),
    (entry): entry is unknown[] => entry !== undefined,
    { timeout: 5_000 },
  );
}

describe("JobProcessor", () => {
  it("logs a failed job with its queue, attempt and the error's cause", async () => {
    const job = await queue.add("work", { kind: "broken" }, { attempts: 2, backoff: 10 });
    const [fields, message] = await failedLog(job.id as string);
    expect(message).toBe("job failed; it will be retried");
    expect(fields).toMatchObject({
      queue: QUEUE,
      jobName: "work",
      attempt: 1,
      attempts: 2,
      final: false,
      err: { message: "outer", cause: { message: "the real reason" } },
    });
  });

  it("says when a job has failed for good, and doesn't retry an unrecoverable one", async () => {
    const job = await queue.add("work", { kind: "bad" }, { attempts: 5 });
    const [fields, message] = await failedLog(job.id as string);
    expect(message).toBe("job failed for good");
    expect(fields).toMatchObject({ final: true, attempt: 1 });
    expect((await queue.getJob(job.id as string))?.attemptsMade).toBe(1);
  });
});

/** The activity line written for a job, from Nest's log or warn calls. */
function activityOf(lines: unknown[][], jobId: string) {
  return eventually(
    () =>
      lines.find(
        (args) =>
          args[1] === "activity" &&
          (args[0] as { target?: { jobId?: string } })?.target?.jobId === jobId,
      ),
    (entry): entry is unknown[] => entry !== undefined,
    { timeout: 5_000 },
  );
}

describe("a job's activity line", () => {
  const meta = { requestId: "r-1", userId: "u-1", orgId: "o-1" };

  it("is written when it's done, for the user it ran for", async () => {
    const job = await queue.add("work", { kind: "good", meta });
    const [line] = await activityOf(infos, job.id as string);
    expect(line).toMatchObject({
      activity: "job.finished",
      outcome: "ok",
      actor: { userId: "u-1" },
      orgId: "o-1",
      requestId: "r-1",
      target: { queue: QUEUE, job: "work", attempt: 1 },
      durationMs: expect.any(Number),
    });
  });

  it("is written at warn when it fails, saying whether it's for good", async () => {
    const job = await queue.add("work", { kind: "broken", meta }, { attempts: 1 });
    const [line] = await activityOf(warnings, job.id as string);
    expect(line).toMatchObject({
      activity: "job.finished",
      outcome: "failed",
      reason: "Error",
      actor: { userId: "u-1" },
      target: { final: true },
    });
  });
});
