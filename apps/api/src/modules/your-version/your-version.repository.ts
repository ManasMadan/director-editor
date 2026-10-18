/**
 * The member's version of a template, as stored: one app.director_version row per member
 * and template, its JSON parsed with the contract's schema on the way out. Row-level
 * security holds every query to the caller's workspace; each names its member.
 */
import { Injectable } from "@nestjs/common";
import { EMPTY_VERSION, type YourVersion, yourVersionSchema } from "@repo/contracts/api";
import type { OrgId, UserId, VideoId } from "@repo/contracts/ids";
import { withTenant } from "@repo/db";
import { type Database, InjectDatabase } from "@repo/nest-common";

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
