/**
 * Reads the audit log (audit schema, written by apps/worker). apps/api may only SELECT
 * it, and row-level security limits that to the tenant set by withTenant.
 */
import { Injectable } from "@nestjs/common";
import type { OrgId } from "@repo/contracts/ids";
import type { PageInput } from "@repo/contracts/pagination";
import { withTenant } from "@repo/db";
import { type Database, InjectDatabase } from "@repo/nest-common";

@Injectable()
export class AuditRepository {
  constructor(@InjectDatabase() private readonly database: Database) {}

  /** Newest first (event ids are UUIDv7, so id order is time order), `limit + 1` rows. */
  list(orgId: OrgId, { limit, cursor }: PageInput) {
    return withTenant(this.database.read, orgId).auditLog.findMany({
      where: { orgId, ...(cursor && { id: { lt: cursor } }) },
      orderBy: { id: "desc" },
      take: limit + 1,
      select: { id: true, name: true, occurredAt: true, actorId: true, payload: true },
    });
  }

  actors(ids: string[]) {
    return this.database.read.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, email: true },
    });
  }
}
