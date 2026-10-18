/**
 * What publishing reads and writes in the database itself: the member's Google account
 * (better-auth's auth.account, which has no row-level security; each query names its
 * user) and how far a cut's publishing got (ai.director_cut, owned by apps/ai, which lets
 * this API update only its publish columns; row-level security holds every write to the
 * caller's workspace). The cut itself is read through the AI service.
 */
import { Injectable } from "@nestjs/common";
import type { DirectorCut } from "@repo/contracts/api";
import type { DirectorCutId, OrgId, UserId } from "@repo/contracts/ids";
import { MINUTE_MS } from "@repo/contracts/time";
import { withTenant } from "@repo/db";
import { type Database, InjectDatabase } from "@repo/nest-common";

/**
 * How long a publish may say "uploading" before it's taken for one that was cut off (the
 * API restarted mid-upload) and may start again: longer than any upload takes.
 */
const STALE_UPLOAD_MS = 15 * MINUTE_MS;

type Visibility = NonNullable<DirectorCut["publish"]["visibility"]>;

@Injectable()
export class PublishRepository {
  constructor(@InjectDatabase() private readonly database: Database) {}

  /** The member's Google account, and the scopes it granted Director (comma-separated). */
  googleAccount(userId: UserId) {
    return this.database.read.account.findFirst({
      where: { userId, providerId: "google" },
      select: { id: true, scope: true },
    });
  }

  /**
   * Marks the cut as uploading, unless it's published or another publish of it is under
   * way: whether this call got it. Two publishes at once (a double click, two tabs) upload
   * it once.
   */
  async claim(orgId: OrgId, userId: UserId, cutId: DirectorCutId) {
    const { count } = await withTenant(this.database.write, orgId).directorCut.updateMany({
      where: {
        id: cutId,
        userId,
        OR: [
          { publishStatus: { in: ["none", "failed"] } },
          {
            publishStatus: "uploading",
            updatedAt: { lt: new Date(Date.now() - STALE_UPLOAD_MS) },
          },
        ],
      },
      data: { publishStatus: "uploading" },
    });
    return count === 1;
  }

  async published(
    orgId: OrgId,
    cutId: DirectorCutId,
    video: { youtubeVideoId: string; visibility: Visibility },
  ) {
    await withTenant(this.database.write, orgId).directorCut.updateMany({
      where: { id: cutId },
      data: { publishStatus: "published", ...video },
    });
  }

  async failed(orgId: OrgId, cutId: DirectorCutId) {
    await withTenant(this.database.write, orgId).directorCut.updateMany({
      where: { id: cutId },
      data: { publishStatus: "failed" },
    });
  }
}
