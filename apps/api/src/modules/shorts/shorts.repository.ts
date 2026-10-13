/**
 * A member's likes and saves of YouTube shorts. Every query runs through withTenant /
 * tenantTx, so row-level security scopes it to the caller's organization.
 */
import { Injectable } from "@nestjs/common";
import type { ShortReactionKind } from "@repo/contracts/api";
import { type OrgId, type UserId, type VideoId, videoIdSchema } from "@repo/contracts/ids";
import { withTenant } from "@repo/db";
import { type Database, InjectDatabase } from "@repo/nest-common";

@Injectable()
export class ShortsRepository {
  constructor(@InjectDatabase() private readonly database: Database) {}

  kinds(orgId: OrgId, userId: UserId, videoId: VideoId) {
    return withTenant(this.database.read, orgId)
      .shortReaction.findMany({ where: { userId, videoId }, select: { kind: true } })
      .then((rows) => new Set(rows.map((row) => row.kind)));
  }

  /** Adds or removes one reaction; doing either twice is the same as once. */
  async set(orgId: OrgId, userId: UserId, videoId: VideoId, kind: ShortReactionKind, on: boolean) {
    const db = withTenant(this.database.write, orgId);
    if (on) {
      await db.shortReaction.createMany({
        data: [{ orgId, userId, videoId, kind }],
        skipDuplicates: true,
      });
    } else {
      await db.shortReaction.deleteMany({ where: { userId, videoId, kind } });
    }
  }

  /** The video ids the member reacted to with `kind`, newest first. */
  videos(orgId: OrgId, userId: UserId, kind: ShortReactionKind, limit: number) {
    return withTenant(this.database.read, orgId)
      .shortReaction.findMany({
        where: { userId, kind },
        orderBy: { id: "desc" },
        take: limit,
        select: { videoId: true },
      })
      .then((rows) => rows.map((row) => videoIdSchema.parse(row.videoId)));
  }
}
