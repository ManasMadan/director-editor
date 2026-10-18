/**
 * The member's version of a template, as stored: one app.director_version row per member
 * and template, its JSON parsed with the contract's schema on the way out. Row-level
 * security holds every query to the caller's workspace; each names its member.
 */
import { Injectable } from "@nestjs/common";
import { EMPTY_VERSION, type YourVersion, yourVersionSchema } from "@repo/contracts/api";
import type { OrgId, UserId, VideoId } from "@repo/contracts/ids";
import { type Tx, withTenant } from "@repo/db";
import { type Database, InjectDatabase, rows } from "@repo/nest-common";
import * as z from "zod";

const heldVersion = z.object({ version: yourVersionSchema });

@Injectable()
export class YourVersionRepository {
  constructor(@InjectDatabase() private readonly database: Database) {}

  /** The member's version, or the empty one when Director hasn't changed anything yet. */
  async find(orgId: OrgId, userId: UserId, videoId: VideoId): Promise<YourVersion> {
    const row = await withTenant(this.database.read, orgId).directorVersion.findUnique({
      where: { orgId_userId_videoId: { orgId, userId, videoId } },
      select: { version: true },
    });
    return row ? yourVersionSchema.parse(row.version) : EMPTY_VERSION;
  }

  /**
   * The member's version inside a transaction, its row held until the transaction ends,
   * so nothing saves over it between this read and the transaction's own write.
   */
  async findHeld(tx: Tx, orgId: OrgId, userId: UserId, videoId: VideoId): Promise<YourVersion> {
    const [held] = await rows(
      heldVersion,
      tx.$queryRaw`SELECT version FROM app.director_version WHERE org_id = ${orgId}::uuid AND user_id = ${userId}::uuid AND video_id = ${videoId} FOR UPDATE`,
    );
    return held ? held.version : EMPTY_VERSION;
  }

  /** Keeps the member's version inside a transaction. */
  async saveIn(tx: Tx, orgId: OrgId, userId: UserId, videoId: VideoId, version: YourVersion) {
    await tx.directorVersion.upsert({
      where: { orgId_userId_videoId: { orgId, userId, videoId } },
      create: { orgId, userId, videoId, version },
      update: { version },
    });
  }

  async save(
    orgId: OrgId,
    userId: UserId,
    videoId: VideoId,
    version: YourVersion,
  ): Promise<YourVersion> {
    await withTenant(this.database.write, orgId).directorVersion.upsert({
      where: { orgId_userId_videoId: { orgId, userId, videoId } },
      create: { orgId, userId, videoId, version },
      update: { version },
    });
    return version;
  }
}
