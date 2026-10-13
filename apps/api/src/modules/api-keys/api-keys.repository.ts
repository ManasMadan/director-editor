/**
 * API keys (auth schema, written by better-auth's api-key plugin) as the workspace's
 * list, and revoking one. The plugin creates and verifies keys; everything else reads
 * and deletes rows here, so it's typed and runs in our transactions.
 */
import { Injectable } from "@nestjs/common";
import type { ApiKeyId, OrgId, UserId } from "@repo/contracts/ids";
import type { Tx } from "@repo/db";
import { type Database, InjectDatabase } from "@repo/nest-common";

const fields = {
  id: true,
  name: true,
  start: true,
  permissions: true,
  metadata: true,
  createdAt: true,
  expiresAt: true,
  lastRequest: true,
} as const;

@Injectable()
export class ApiKeysRepository {
  constructor(@InjectDatabase() private readonly database: Database) {}

  list(orgId: OrgId) {
    return this.database.read.apikey.findMany({
      where: { referenceId: orgId },
      orderBy: { createdAt: "desc" },
      select: fields,
    });
  }

  /** From the primary: a key just created must be found at once. */
  find(orgId: OrgId, id: ApiKeyId) {
    return this.database.write.apikey.findFirstOrThrow({
      where: { id, referenceId: orgId },
      select: fields,
    });
  }

  count(orgId: OrgId) {
    return this.database.write.apikey.count({ where: { referenceId: orgId } });
  }

  users(ids: UserId[]) {
    return this.database.read.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
  }

  findForRevoke(tx: Tx, orgId: OrgId, id: ApiKeyId) {
    return tx.apikey.findFirst({
      where: { id, referenceId: orgId },
      select: { id: true, name: true },
    });
  }

  remove(tx: Tx, id: string) {
    return tx.apikey.delete({ where: { id } });
  }
}

export type ApiKeyRow = NonNullable<Awaited<ReturnType<ApiKeysRepository["find"]>>>;
