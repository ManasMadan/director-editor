/**
 * The member's version of a template (@repo/contracts your-version.ts): kept here, in
 * the API's own table, and re-planned by Gemini in the AI service (apps/ai/app/revise.py),
 * which keeps nothing itself.
 */
import { isDeepStrictEqual } from "node:util";
import { Injectable } from "@nestjs/common";
import {
  type ReviseResult,
  shotVersionSchema,
  type YourVersion,
  yourVersionSchema,
} from "@repo/contracts/api";
import type { OrgId, UserId, VideoId } from "@repo/contracts/ids";
import { tenantTx } from "@repo/db";
import { type Database, InjectDatabase } from "@repo/nest-common";
import * as z from "zod";
import { aiCaller, callAi } from "../ai";
import { YourVersionRepository } from "./your-version.repository";

/** A field Python left as null is a row the version doesn't change: left out here. */
const withoutNulls = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));

const revisedSchema = z.object({
  version: yourVersionSchema.extend({
    shots: z.array(
      z.record(z.string(), z.unknown()).transform(withoutNulls).pipe(shotVersionSchema),
    ),
  }),
  summary: z.string(),
});

@Injectable()
export class YourVersionService {
  constructor(
    private readonly versions: YourVersionRepository,
    @InjectDatabase() private readonly database: Database,
  ) {}

  get(userId: UserId, orgId: OrgId, videoId: VideoId): Promise<YourVersion> {
    return this.versions.find(orgId, userId, videoId);
  }

  save(userId: UserId, orgId: OrgId, videoId: VideoId, version: YourVersion) {
    return this.versions.save(orgId, userId, videoId, version);
  }

  /**
   * Gemini re-plans the version from the instruction; the result is kept, then answered.
   * A re-plan takes seconds: if the member saved a change meanwhile (a chip taken away, a
   * row put back), that version stays, and the screen makes their change again on top of
   * the re-plan it's answered with.
   */
  async revise(
    userId: UserId,
    orgId: OrgId,
    input: { videoId: VideoId; instruction: string; version: YourVersion },
  ): Promise<ReviseResult> {
    const { videoId, instruction, version } = input;
    const before = await this.versions.find(orgId, userId, videoId);
    const answer = await callAi((ai) =>
      ai.director.revise(aiCaller(userId, orgId), videoId, { instruction, version }),
    );
    const revised = revisedSchema.parse(answer);
    await tenantTx(this.database.write, orgId, async (tx) => {
      const now = await this.versions.findHeld(tx, orgId, userId, videoId);
      if (isDeepStrictEqual(now, before)) {
        await this.versions.saveIn(tx, orgId, userId, videoId, revised.version);
      }
    });
    return revised;
  }
}
