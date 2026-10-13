/**
 * OAuth approvals (auth schema, written by better-auth's oauth-provider plugin) as the
 * user's list of connected apps, and removing one with every token issued under it.
 */
import { Injectable } from "@nestjs/common";
import type { UserId } from "@repo/contracts/ids";
import type { Tx } from "@repo/db";
import { type Database, InjectDatabase } from "@repo/nest-common";

@Injectable()
export class AppsRepository {
  constructor(@InjectDatabase() private readonly database: Database) {}

  list(userId: UserId) {
    return this.database.read.oauthConsent.findMany({
      where: { userId, referenceId: { not: null } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        clientId: true,
        referenceId: true,
        scopes: true,
        createdAt: true,
        client: { select: { name: true, uri: true } },
        organization: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * When each (client, workspace) pair of the user's last renewed its access. Access
   * tokens are JWTs and aren't stored; every grant and refresh issues a refresh token.
   */
  lastUsed(userId: UserId) {
    return this.database.read.oauthRefreshToken.groupBy({
      by: ["clientId", "referenceId"],
      where: { userId },
      _max: { createdAt: true },
    });
  }

  find(tx: Tx, id: string, userId: UserId) {
    return tx.oauthConsent.findFirst({
      where: { id, userId },
      select: { id: true, clientId: true, referenceId: true },
    });
  }

  /** The approval and everything issued under it (refresh tokens take their access tokens). */
  async remove(
    tx: Tx,
    grant: { id: string; clientId: string; referenceId: string },
    userId: UserId,
  ) {
    const issued = { clientId: grant.clientId, userId, referenceId: grant.referenceId };
    await tx.oauthRefreshToken.deleteMany({ where: issued });
    await tx.oauthAccessToken.deleteMany({ where: issued });
    await tx.oauthConsent.delete({ where: { id: grant.id } });
  }
}
