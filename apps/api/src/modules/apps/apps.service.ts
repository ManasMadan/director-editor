/**
 * Connected apps: what the user approved (settings, Security) and disconnecting them.
 * Disconnecting is immediate: the approval and its tokens are gone, and both MCP servers
 * check the approval on every request (auth.mcp_grant_active).
 */
import { Injectable } from "@nestjs/common";
import type { ConnectedApp } from "@repo/contracts/api";
import { orgIdSchema, type UserId } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import { transaction } from "@repo/db";
import { AppError, type Database, InjectDatabase } from "@repo/nest-common";
import { emitEvent } from "../../outbox";
import { AppsRepository } from "./apps.repository";

@Injectable()
export class AppsService {
  constructor(
    @InjectDatabase() private readonly database: Database,
    private readonly apps: AppsRepository,
  ) {}

  async list(userId: UserId): Promise<ConnectedApp[]> {
    const [grants, used] = await Promise.all([this.apps.list(userId), this.apps.lastUsed(userId)]);
    const lastUsed = new Map(
      used.map((row) => [`${row.clientId}:${row.referenceId}`, row._max.createdAt]),
    );
    return grants.map((grant) => {
      // Listed grants name a workspace, and deleting one deletes its grants (cascade).
      const workspace = required(grant.organization, "the grant's workspace");
      return {
        id: grant.id,
        clientId: grant.clientId,
        name: grant.client.name,
        uri: grant.client.uri,
        workspace: { id: orgIdSchema.parse(workspace.id), name: workspace.name },
        scopes: grant.scopes,
        connectedAt: grant.createdAt,
        lastUsedAt: lastUsed.get(`${grant.clientId}:${grant.referenceId}`) ?? null,
      };
    });
  }

  disconnect(userId: UserId, id: string) {
    return transaction(this.database.write, async (tx) => {
      const grant = await this.apps.find(tx, id, userId);
      if (!grant?.referenceId) {
        throw new AppError("APP_NOT_FOUND");
      }
      await this.apps.remove(tx, { ...grant, referenceId: grant.referenceId }, userId);
      // An approval's reference is the workspace it was given for (auth/auth-plugins.ts).
      const organizationId = orgIdSchema.parse(grant.referenceId);
      await emitEvent(
        tx,
        "auth.app_disconnected.v1",
        grant.id,
        { userId, clientId: grant.clientId, organizationId },
        { actorId: userId, orgId: null },
      );
    });
  }
}
